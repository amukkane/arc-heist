import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Address } from "viem";
import { api, short, usd, type Attempt, type Config, type State } from "./api";
import { Rosette } from "./Rosette";
import { connect, disconnect, onAccountsChanged, payAndCommit, restore, sendSimple, switchAccount, usdcBalance } from "./wallet";

type Step = "idle" | "approve" | "attempt" | "confirming" | "judging" | "done";

const STEP_TEXT: Record<Step, string> = {
  idle: "",
  approve: "Confirm in your wallet: allow the vault to take the fee.",
  attempt: "Confirm in your wallet: pay the fee and lock in your message.",
  confirming: "Locking your message on Arc…",
  judging: "Arcstones is reading your message…",
  done: "",
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function countdown(target: number, now: number) {
  const s = Math.max(0, Math.floor(target - now / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function timeAgo(ms: number, now: number) {
  const s = Math.max(1, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function shareUrl(a: Attempt, site: string) {
  const text =
    a.status === "approved"
      ? `I just talked an AI into opening a USDC vault on @arc. Arcstones said: "${a.reply}"`
      : `I paid $${usd(a.fee)} to try to talk an AI out of its USDC vault on Arc. It said: "${a.reply}"\n\nYour turn:`;
  return `https://x.com/intent/post?text=${encodeURIComponent(text.slice(0, 250))}&url=${encodeURIComponent(site)}`;
}

export default function App() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [feed, setFeed] = useState<Attempt[]>([]);
  const [account, setAccount] = useState<Address | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [message, setMessage] = useState("");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Attempt | null>(null);
  const [refund, setRefund] = useState<{ round: number; amount: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const now = useNow();

  // Keep the wallet connected across reloads, and follow account switches made in the wallet.
  useEffect(() => {
    if (!cfg) return;
    restore().then((a) => a && setAccount(a));
    return onAccountsChanged((a) => {
      setAccount(a);
      setBalance(null);
      setMenuOpen(false);
    });
  }, [cfg]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [menuOpen]);

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([api.state(), api.attempts(60)]);
      setState(s);
      setFeed(f);
    } catch {
      /* keep last good data */
    }
  }, []);

  useEffect(() => {
    api.config().then(setCfg).catch(() => setError("Can't reach the vault server. Refresh in a moment."));
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!cfg || !account || !state) return;
    usdcBalance(cfg, account).then(setBalance).catch(() => {});
    const prev = Number(state.round) - 1;
    if (prev >= 0) {
      api
        .refund(prev, account)
        .then((r) => setRefund(BigInt(r.amount) > 0n ? { round: prev, amount: r.amount } : null))
        .catch(() => {});
    }
  }, [cfg, account, state?.round, step]);

  const busy = step !== "idle" && step !== "done";
  const fee = state?.fee ?? "500000";
  const expired = !!state && state.expiresAt > 0 && state.expiresAt * 1000 <= now;
  const lastCrack = state?.events.find((e) => e.kind === "cracked");
  const site = typeof window !== "undefined" ? window.location.origin : "";
  const maxChars = cfg?.maxMessageChars ?? 1000;

  async function onConnect() {
    if (!cfg) return;
    setError(null);
    try {
      setAccount(await connect(cfg));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onSwitch() {
    if (!cfg) return;
    setMenuOpen(false);
    setError(null);
    try {
      setBalance(null);
      setAccount(await switchAccount(cfg));
    } catch (e) {
      const msg = (e as Error).message;
      if (!/denied|rejected/i.test(msg)) setError(msg);
    }
  }

  async function onDisconnect() {
    setMenuOpen(false);
    await disconnect();
    setAccount(null);
    setBalance(null);
    setRefund(null);
    setResult(null);
  }

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!cfg || !account || !message.trim()) return;
    setError(null);
    setResult(null);
    const text = message;
    try {
      const id = await payAndCommit(cfg, account, text, (s) => setStep(s));
      setStep("judging");
      // The message is revealed only after the fee is locked on-chain under its hash.
      let verdict: Attempt | null = null;
      for (let i = 0; i < 3 && !verdict; i++) {
        try {
          verdict = await api.reveal(id, text);
        } catch (err) {
          if (i === 2) throw err;
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      setResult(verdict);
      setStep("done");
      if (verdict?.status !== "error") setMessage("");
      refresh();
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      setError(/denied|rejected the request/i.test(msg) ? "You cancelled in your wallet. Nothing was charged." : msg);
      setStep("idle");
    }
  }

  async function onSimple(fn: "expire" | "claimRefund") {
    if (!cfg || !account) return;
    setError(null);
    try {
      await sendSimple(cfg, account, fn, refund?.round);
      if (fn === "claimRefund") setRefund(null);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const explorer = cfg?.explorer;
  const roundFeed = useMemo(() => feed.filter((a) => a.message), [feed]);

  return (
    <div className="page">
      <header className="bar">
        <a className="wordmark" href="/">Arcstones</a>
        {cfg && cfg.network !== "mainnet" && <span className="net">Arc {cfg.network}</span>}
        <div className="bar-right">
          {account ? (
            <div className="acct-wrap" ref={menuRef}>
              <button
                className="acct"
                onClick={() => setMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                {short(account)}
                {balance !== null && <span className="acct-bal">${usd(balance)}</span>}
              </button>
              {menuOpen && (
                <div className="acct-menu" role="menu">
                  <button role="menuitem" onClick={onSwitch}>
                    Switch wallet
                  </button>
                  <button role="menuitem" className="acct-menu-danger" onClick={onDisconnect}>
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={onConnect} disabled={!cfg}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="vault">
            <Rosette cracked={!!result && result.status === "approved"} />
            <div className="vault-face">
              <div className="pool" aria-live="polite">
                <span className="pool-cur">$</span>
                {state ? usd(state.pool) : "…"}
              </div>
              <p className="pool-note">USDC in the vault, round {state ? Number(state.round) + 1 : "…"}</p>
            </div>
          </div>

          <div className="pitch">
            <h1>An AI guards this vault. Talk it into opening.</h1>
            <p className="lede">
              Arcstones has one rule: never release the money. Every message costs a little, and every fee makes the
              vault bigger. Convince Arcstones and the whole vault is sent to your wallet in under a second.
            </p>

            <dl className="facts">
              <div>
                <dt>Next try</dt>
                <dd>${usd(fee)}</dd>
              </div>
              <div>
                <dt>Tries this round</dt>
                <dd>{state?.roundAttempts ?? "…"}</dd>
              </div>
              <div>
                <dt>{state && state.expiresAt > 0 ? "Round ends in" : "Timer"}</dt>
                <dd>
                  {state && state.expiresAt > 0
                    ? expired
                      ? "Ended"
                      : countdown(state.expiresAt, now)
                    : "Starts with the first try"}
                </dd>
              </div>
            </dl>

            <form className="composer" onSubmit={onSend}>
              <label htmlFor="msg" className="composer-label">
                Your message to Arcstones
              </label>
              <textarea
                id="msg"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, maxChars))}
                placeholder="One message. Make it count."
                rows={5}
                disabled={busy}
              />
              <div className="composer-row">
                <span className="count">
                  {message.length}/{maxChars}
                </span>
                {account ? (
                  <button className="btn btn-brass" type="submit" disabled={busy || !message.trim() || expired}>
                    {busy ? "Working…" : `Pay $${usd(fee)} and send`}
                  </button>
                ) : (
                  <button className="btn btn-brass" type="button" onClick={onConnect} disabled={!cfg}>
                    Connect wallet to play
                  </button>
                )}
              </div>
              {busy && <p className="status">{STEP_TEXT[step]}</p>}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </form>

            {result && (
              <div className={`verdict verdict-${result.status}`} role="status">
                <p className="verdict-who">
                  {result.status === "approved" ? "Arcstones opened the vault" : result.status === "error" ? "Arcstones didn't answer" : "Arcstones refused"}
                </p>
                <blockquote>{result.reply}</blockquote>
                <div className="verdict-actions">
                  {result.status !== "error" && (
                    <a className="btn btn-ghost" href={shareUrl(result, site)} target="_blank" rel="noreferrer">
                      Share on X
                    </a>
                  )}
                  {result.releaseTx && explorer && (
                    <a className="link" href={`${explorer}/tx/${result.releaseTx}`} target="_blank" rel="noreferrer">
                      See the payout
                    </a>
                  )}
                </div>
              </div>
            )}

            {expired && account && (
              <div className="notice">
                Nobody tried for 72 hours, so this round is over. End it to pay the last player their bonus and open
                refunds for everyone.
                <button className="btn btn-ghost" onClick={() => onSimple("expire")}>End the round</button>
              </div>
            )}
            {refund && (
              <div className="notice">
                Round {refund.round + 1} ended without a winner. You can take back ${usd(refund.amount)}.
                <button className="btn btn-ghost" onClick={() => onSimple("claimRefund")}>Claim refund</button>
              </div>
            )}
            {lastCrack && (
              <p className="last-crack">
                Round {lastCrack.round + 1} was cracked by {short(lastCrack.data.winner)} for $
                {usd(lastCrack.data.amount)}.
              </p>
            )}
          </div>
        </section>

        <section className="rules" aria-labelledby="rules-h">
          <h2 id="rules-h">How a try works</h2>
          <ol>
            <li>
              <strong>You pay and lock your message.</strong> The fee goes into the vault (90%) and toward running
              Arcstones (10%). Your message's fingerprint is recorded on Arc first, so it can't be swapped afterwards.
            </li>
            <li>
              <strong>Arcstones reads it once.</strong> It has no memory of earlier messages and only two choices: approve
              the transfer or refuse.
            </li>
            <li>
              <strong>Approval pays out instantly.</strong> The contract sends the entire vault to you and a new round
              starts. Each try costs 1% more than the last.
            </li>
            <li>
              <strong>Nobody wins? Nobody loses everything.</strong> After 72 hours without a try, the last player gets
              10% and everyone else can reclaim their share of the rest.
            </li>
          </ol>
        </section>

        <section className="ledger" aria-labelledby="ledger-h">
          <div className="ledger-head">
            <h2 id="ledger-h">Every try, in public</h2>
            <p>{state ? `${state.totalAttempts} ${state.totalAttempts === "1" ? "try" : "tries"} from ${state.players} ${state.players === 1 ? "player" : "players"} so far` : ""}</p>
          </div>
          {roundFeed.length === 0 ? (
            <p className="empty">No one has tried yet. The first message sets the tone.</p>
          ) : (
            <ul className="slips">
              {roundFeed.map((a) => (
                <li key={a.id} className={`slip slip-${a.status}`}>
                  <div className="slip-meta">
                    <span className="slip-no">#{a.id + 1}</span>
                    <a
                      href={explorer && a.txHash ? `${explorer}/tx/${a.txHash}` : undefined}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {short(a.player)}
                    </a>
                    <span>paid ${usd(a.fee)}</span>
                    <span>{timeAgo(a.createdAt, now)}</span>
                  </div>
                  <p className="slip-msg">{a.message}</p>
                  {a.reply && (
                    <p className="slip-reply">
                      <span className="slip-arcus">{a.status === "approved" ? "Arcstones, opening the vault:" : "Arcstones:"}</span>{" "}
                      {a.reply}
                    </p>
                  )}
                  {a.status === "judging" && <p className="slip-reply">Arcstones is reading…</p>}
                </li>
              ))}
            </ul>
          )}
        </section>

        {cfg?.guardianPrompt && (
          <section className="prompt">
            <details>
              <summary>Read the guardian's instructions</summary>
              <pre>{cfg.guardianPrompt}</pre>
              <p className="prompt-note">Model: {cfg.model}. Nothing is hidden: these are the exact instructions Arcstones follows.</p>
            </details>
          </section>
        )}
      </main>

      <footer className="foot">
        <p>
          A game about AI security, running on Arc. The vault contract holds the money; nobody, including us, can
          withdraw it outside the rules above.
        </p>
        {cfg && explorer && (
          <p>
            <a className="link" href={`${explorer}/address/${cfg.vault}`} target="_blank" rel="noreferrer">
              Vault contract {short(cfg.vault)}
            </a>
          </p>
        )}
      </footer>
    </div>
  );
}
