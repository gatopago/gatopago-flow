import { spawn } from "node:child_process";
import {
  createTestClient,
  erc20Abi,
  http,
  parseAbi,
  parseEther,
  publicActions,
  walletActions,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { walletNetworks } from "@gatopago/shared/networks";
import { FORKS, PAYER_KEY, ROUTER_OWNER, SIGNER_KEY, forkUrl } from "./forks";

/**
 * Vitest global setup: each fork's router accepts the test signer's authorizations, and the payer
 * holds 20 USDC.
 */
export default async function setup() {
  const processes = FORKS.map((fork) =>
    spawn("anvil", ["--fork-url", fork.url, "--port", String(fork.port), "--silent"], {
      stdio: "ignore",
    }),
  );
  await Promise.all(
    FORKS.map(async (fork) => {
      const network = walletNetworks[fork.id];
      const client = createTestClient({
        chain: network.chain,
        mode: "anvil",
        transport: http(forkUrl(fork.port)),
      })
        .extend(publicActions)
        .extend(walletActions);
      for (let attempt = 0; ; attempt++) {
        try {
          await client.getChainId();
          break;
        } catch (error) {
          if (attempt > 150) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      const send = async (from: Address, request: object) => {
        await client.impersonateAccount({ address: from });
        await client.setBalance({ address: from, value: parseEther("100") });
        const hash = await client.writeContract({ account: from, ...request } as never);
        await client.waitForTransactionReceipt({ hash });
      };
      await send(ROUTER_OWNER, {
        address: network.paymentRouter,
        abi: parseAbi(["function setSigner(address)"]),
        functionName: "setSigner",
        args: [privateKeyToAccount(SIGNER_KEY).address],
      });
      await send(fork.usdcHolder, {
        address: network.usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [privateKeyToAccount(PAYER_KEY).address, 20_000_000n],
      });
      await client.setBalance({
        address: privateKeyToAccount(PAYER_KEY).address,
        value: parseEther("10"),
      });
    }),
  );
  return () => processes.forEach((process) => process.kill());
}
