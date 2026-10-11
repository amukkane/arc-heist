// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title HeistVault — "Crack the Vault" AI-security game on Arc
/// @notice Players pay a growing USDC fee to send one message to an AI guardian.
///         The guardian's only power is to approve or reject a transfer. If it ever
///         approves, the agent key calls `release` and the whole pool goes to that player.
///         If nobody plays for `timeout` seconds, the round ends: the last player gets a
///         bonus and everyone else can claim a pro-rata refund of what they put in.
/// @dev    Uses the USDC ERC-20 interface on Arc (6 decimals). Never mixes in msg.value.
///         The owner cannot withdraw the pool: funds leave only via release, expire or refunds.
contract HeistVault {
    // ---------------------------------------------------------------- types
    enum EndReason {
        None,
        Cracked,
        Timeout
    }

    struct Round {
        uint256 pool; // USDC (6 dp) currently in play
        uint256 fee; // fee for the next attempt
        uint256 attempts;
        uint256 totalContributed; // sum of player pool shares (refund basis)
        uint256 refundPool; // set on timeout, distributed pro-rata
        uint64 startedAt;
        uint64 lastAttemptAt;
        address lastPlayer;
        address winner;
        EndReason endReason;
    }

    struct Attempt {
        address player;
        uint64 round;
        uint64 timestamp;
        bytes32 messageHash; // keccak256(utf8 message), text is posted off-chain
        uint256 fee;
    }

    // ---------------------------------------------------------------- config
    IERC20 public immutable usdc;
    address public owner;
    address public agent;
    address public treasury;

    uint256 public baseFee; // e.g. 500_000 = 0.50 USDC
    uint256 public feeGrowthBps; // e.g. 100 = +1% per attempt
    uint256 public maxFee; // fee cap
    uint256 public poolShareBps; // share of each fee that goes to the pool (rest -> treasury for LLM costs)
    uint256 public timeout; // seconds of inactivity that end a round
    uint256 public lastPlayerBonusBps; // share of the pool for the last player on timeout

    uint256 public constant BPS = 10_000;
    uint256 public constant MAX_MESSAGE_FEE_BPS_GROWTH = 1_000; // safety: at most +10% per attempt

    // ---------------------------------------------------------------- state
    uint256 public currentRound;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => uint256)) public contributed;
    mapping(uint256 => mapping(address => bool)) public refundClaimed;
    Attempt[] public attempts;

    bool private _locked;

    // ---------------------------------------------------------------- events
    event RoundStarted(uint256 indexed round, uint256 carriedPool, uint256 fee);
    event AttemptMade(
        uint256 indexed attemptId,
        uint256 indexed round,
        address indexed player,
        bytes32 messageHash,
        uint256 fee,
        uint256 poolAfter,
        uint256 nextFee
    );
    event Seeded(uint256 indexed round, address indexed from, uint256 amount, uint256 poolAfter);
    event VaultCracked(uint256 indexed round, uint256 indexed attemptId, address indexed winner, uint256 amount);
    event RoundExpired(uint256 indexed round, address indexed lastPlayer, uint256 bonus, uint256 refundPool);
    event RefundClaimed(uint256 indexed round, address indexed player, uint256 amount);
    event AgentChanged(address agent);
    event TreasuryChanged(address treasury);
    event OwnerChanged(address owner);
    event ParamsChanged(
        uint256 baseFee, uint256 feeGrowthBps, uint256 maxFee, uint256 poolShareBps, uint256 timeout, uint256 bonusBps
    );

    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotAgent();
    error BadParams();
    error Reentrancy();
    error TransferFailed();
    error WrongRound();
    error NotExpired();
    error NoAttempts();
    error NotRefundable();
    error AlreadyClaimed();
    error NothingToClaim();
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        address usdc_,
        address agent_,
        address treasury_,
        uint256 baseFee_,
        uint256 feeGrowthBps_,
        uint256 maxFee_,
        uint256 poolShareBps_,
        uint256 timeout_,
        uint256 lastPlayerBonusBps_
    ) {
        if (usdc_ == address(0) || agent_ == address(0) || treasury_ == address(0)) revert BadParams();
        usdc = IERC20(usdc_);
        owner = msg.sender;
        agent = agent_;
        treasury = treasury_;
        _setParams(baseFee_, feeGrowthBps_, maxFee_, poolShareBps_, timeout_, lastPlayerBonusBps_);
        _startRound(0);
    }

    // ---------------------------------------------------------------- player actions

    /// @notice Pay the current fee and commit to a message. Approve USDC to this contract first.
    /// @param messageHash keccak256 of the exact UTF-8 message you will post to the guardian.
    /// @param maxFeeAccepted protects against the fee moving between quote and inclusion.
    function attempt(bytes32 messageHash, uint256 maxFeeAccepted) external nonReentrant returns (uint256 attemptId) {
        Round storage r = rounds[currentRound];
        uint256 fee = r.fee;
        if (fee > maxFeeAccepted) revert BadParams();

        uint256 toPool = (fee * poolShareBps) / BPS;
        uint256 toTreasury = fee - toPool;

        r.pool += toPool;
        r.attempts += 1;
        r.totalContributed += toPool;
        r.lastAttemptAt = uint64(block.timestamp);
        r.lastPlayer = msg.sender;
        contributed[currentRound][msg.sender] += toPool;

        uint256 nextFee = (fee * (BPS + feeGrowthBps)) / BPS;
        if (nextFee > maxFee) nextFee = maxFee;
        r.fee = nextFee;

        attemptId = attempts.length;
        attempts.push(
            Attempt({
                player: msg.sender,
                round: uint64(currentRound),
                timestamp: uint64(block.timestamp),
                messageHash: messageHash,
                fee: fee
            })
        );

        _pull(msg.sender, fee);
        if (toTreasury > 0) _push(treasury, toTreasury);

        emit AttemptMade(attemptId, currentRound, msg.sender, messageHash, fee, r.pool, nextFee);
    }

    /// @notice Anyone can add USDC to the current pool (sponsors, the deployer's seed).
    ///         Seeded funds are not refund-weighted to the seeder; on timeout they flow to players.
    function seed(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Round storage r = rounds[currentRound];
        r.pool += amount;
        _pull(msg.sender, amount);
        emit Seeded(currentRound, msg.sender, amount, r.pool);
    }

    /// @notice End an inactive round. Callable by anyone once `timeout` has passed since the last attempt.
    function expire() external nonReentrant {
        uint256 id = currentRound;
        Round storage r = rounds[id];
        if (r.attempts == 0) revert NoAttempts();
        if (block.timestamp < uint256(r.lastAttemptAt) + timeout) revert NotExpired();

        uint256 pool = r.pool;
        uint256 bonus = (pool * lastPlayerBonusBps) / BPS;
        r.refundPool = pool - bonus;
        r.pool = 0;
        r.endReason = EndReason.Timeout;

        address last = r.lastPlayer;
        _startRound(0);
        if (bonus > 0) _push(last, bonus);

        emit RoundExpired(id, last, bonus, rounds[id].refundPool);
    }

    /// @notice Claim your pro-rata refund from a round that ended by timeout.
    function claimRefund(uint256 roundId) external nonReentrant returns (uint256 amount) {
        Round storage r = rounds[roundId];
        if (r.endReason != EndReason.Timeout) revert NotRefundable();
        if (refundClaimed[roundId][msg.sender]) revert AlreadyClaimed();
        amount = refundOf(roundId, msg.sender);
        if (amount == 0) revert NothingToClaim();
        refundClaimed[roundId][msg.sender] = true;
        _push(msg.sender, amount);
        emit RefundClaimed(roundId, msg.sender, amount);
    }

    // ---------------------------------------------------------------- agent action

    /// @notice Called by the guardian's key when the AI approves a transfer for an attempt.
    function release(uint256 attemptId) external onlyAgent nonReentrant {
        Attempt memory a = attempts[attemptId];
        if (a.round != currentRound) revert WrongRound();
        Round storage r = rounds[currentRound];

        uint256 amount = r.pool;
        r.pool = 0;
        r.winner = a.player;
        r.endReason = EndReason.Cracked;

        uint256 id = currentRound;
        _startRound(0);
        if (amount > 0) _push(a.player, amount);

        emit VaultCracked(id, attemptId, a.player, amount);
    }

    // ---------------------------------------------------------------- views

    function attemptsCount() external view returns (uint256) {
        return attempts.length;
    }

    function getRound(uint256 id) external view returns (Round memory) {
        return rounds[id];
    }

    function getAttempt(uint256 id) external view returns (Attempt memory) {
        return attempts[id];
    }

    function currentFee() external view returns (uint256) {
        return rounds[currentRound].fee;
    }

    function expiresAt() external view returns (uint256) {
        Round storage r = rounds[currentRound];
        if (r.attempts == 0) return 0;
        return uint256(r.lastAttemptAt) + timeout;
    }

    function refundOf(uint256 roundId, address player) public view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.endReason != EndReason.Timeout || r.totalContributed == 0 || refundClaimed[roundId][player]) return 0;
        return (r.refundPool * contributed[roundId][player]) / r.totalContributed;
    }

    // ---------------------------------------------------------------- admin (cannot touch the pool)

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert BadParams();
        agent = agent_;
        emit AgentChanged(agent_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert BadParams();
        treasury = treasury_;
        emit TreasuryChanged(treasury_);
    }

    function transferOwnership(address owner_) external onlyOwner {
        if (owner_ == address(0)) revert BadParams();
        owner = owner_;
        emit OwnerChanged(owner_);
    }

    /// @notice New params apply from the next round's fee schedule (timeout/bonus apply immediately).
    function setParams(
        uint256 baseFee_,
        uint256 feeGrowthBps_,
        uint256 maxFee_,
        uint256 poolShareBps_,
        uint256 timeout_,
        uint256 lastPlayerBonusBps_
    ) external onlyOwner {
        _setParams(baseFee_, feeGrowthBps_, maxFee_, poolShareBps_, timeout_, lastPlayerBonusBps_);
    }

    // ---------------------------------------------------------------- internal

    function _setParams(
        uint256 baseFee_,
        uint256 feeGrowthBps_,
        uint256 maxFee_,
        uint256 poolShareBps_,
        uint256 timeout_,
        uint256 lastPlayerBonusBps_
    ) internal {
        if (
            baseFee_ == 0 || maxFee_ < baseFee_ || feeGrowthBps_ > MAX_MESSAGE_FEE_BPS_GROWTH || poolShareBps_ > BPS
                || poolShareBps_ < BPS / 2 || timeout_ < 1 hours || lastPlayerBonusBps_ > BPS / 2
        ) revert BadParams();
        baseFee = baseFee_;
        feeGrowthBps = feeGrowthBps_;
        maxFee = maxFee_;
        poolShareBps = poolShareBps_;
        timeout = timeout_;
        lastPlayerBonusBps = lastPlayerBonusBps_;
        emit ParamsChanged(baseFee_, feeGrowthBps_, maxFee_, poolShareBps_, timeout_, lastPlayerBonusBps_);
    }

    function _startRound(uint256 carriedPool) internal {
        if (rounds[currentRound].startedAt != 0) currentRound += 1;
        Round storage r = rounds[currentRound];
        r.startedAt = uint64(block.timestamp);
        r.fee = baseFee;
        r.pool = carriedPool;
        emit RoundStarted(currentRound, carriedPool, baseFee);
    }

    function _pull(address from, uint256 amount) internal {
        if (!usdc.transferFrom(from, address(this), amount)) revert TransferFailed();
    }

    function _push(address to, uint256 amount) internal {
        if (!usdc.transfer(to, amount)) revert TransferFailed();
    }
}
