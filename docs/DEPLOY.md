# Деплой Arc Heist (testnet → mainnet)

Все команды запускаются на сервере (Ubuntu 22.04+). Секретные ключи вводишь сама, в репозиторий они не попадают (`backend/.env` в `.gitignore`).

## 0. Подготовка сервера

```bash
curl -fsSL https://get.docker.com | sh
curl -L https://foundry.paradigm.xyz | bash && source ~/.bashrc && foundryup
git clone --recurse-submodules https://github.com/amukkane/arc-heist && cd arc-heist
```

## 1. Два кошелька

```bash
cast wallet new   # DEPLOYER: владелец контракта и казна (10% от взносов)
cast wallet new   # AGENT: ключ стража, может только вызвать release()
```

Положи на оба немного USDC на Arc: газ платится в USDC. На testnet бери из https://faucet.circle.com. На AGENT хватит 1–2 USDC, на DEPLOYER — газ плюс стартовый пул.

## 2. Деплой контракта

```bash
cd contracts
export DEPLOYER_KEY=0x...      # вводишь сама
export AGENT_ADDRESS=0x...     # адрес AGENT

# testnet
forge script script/Deploy.s.sol --tc Deploy --rpc-url arc_testnet --broadcast --private-key $DEPLOYER_KEY
# mainnet (когда testnet проверен)
forge script script/Deploy.s.sol --tc Deploy --rpc-url arc --broadcast --private-key $DEPLOYER_KEY
```

Запиши адрес `HeistVault deployed at 0x...` и номер блока из вывода.

Параметры по умолчанию можно переопределить переменными окружения: `BASE_FEE=500000` (0.50 USDC), `FEE_GROWTH_BPS=100` (+1%), `MAX_FEE=10000000`, `POOL_SHARE_BPS=9000`, `TIMEOUT_SECONDS=259200`, `LAST_PLAYER_BONUS_BPS=1000`.

## 3. Стартовый пул

```bash
export VAULT=0x...   # адрес из шага 2
export RPC=https://rpc.mainnet.arc.io   # или https://rpc.testnet.arc.io
cast send 0x3600000000000000000000000000000000000000 "approve(address,uint256)" $VAULT 10000000 \
  --rpc-url $RPC --private-key $DEPLOYER_KEY --gas-price 25gwei
cast send $VAULT "seed(uint256)" 10000000 --rpc-url $RPC --private-key $DEPLOYER_KEY --gas-price 25gwei   # 10 USDC
```

## 4. Запуск агента и сайта

```bash
cd ..
cp backend/.env.example backend/.env
nano backend/.env    # ARC_NETWORK, VAULT_ADDRESS, START_BLOCK, AGENT_PRIVATE_KEY, LLM_API_KEY
# если есть домен, направь A-запись на сервер и:
echo "DOMAIN=heist.example.com" > .env
docker compose up -d --build
docker compose logs -f heist
```

Сайт откроется на `http://<IP сервера>` (или `https://<домен>`). Проверка: `curl localhost/api/health`.

## 5. Обновление

```bash
git pull && docker compose up -d --build
```

## 6. Подача на DoraHacks

Текст для формы лежит в [docs/SUBMISSION.md](SUBMISSION.md). Нужны: ссылка на сайт в mainnet, ссылка на репозиторий, адрес контракта в эксплорере, профиль GitHub/X.
