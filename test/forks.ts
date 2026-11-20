/** Anvil's default keys: Flow's authorization signer, a payer with an external wallet, and Flow's sweeper. */
export const SIGNER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
export const PAYER_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
export const SWEEPER_KEY = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
export const ROUTER_OWNER = '0x75464f762bc50d0A0B127ab5a085504BF102Bb88';

/** Forks of the networks where the payment routers are deployed, and a Circle USDC holder on each. */
export const FORKS = [
  {
    id: 'eip155:421614',
    port: 8731,
    url: 'https://sepolia-rollup.arbitrum.io/rpc',
    usdcHolder: '0x460b97bd498e1157530aeb3086301d5225b91216',
  },
  {
    id: 'eip155:43113',
    port: 8732,
    // Avalanche's own public RPC answers 500 to the state reads a fork makes.
    url: 'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    usdcHolder: '0x9cfcc1b289e59fbe1e769f020c77315df8473760',
  },
] as const;
export const forkUrl = (port: number) => `http://127.0.0.1:${port}`;
