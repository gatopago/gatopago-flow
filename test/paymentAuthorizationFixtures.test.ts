import { describe, expect, it } from "vitest";
import { hashStruct, hashTypedData, keccak256, stringToHex, type Address, type Hex } from "viem";
import fixture from "@gatopago/shared/fixtures/payment-authorizations.json";
import {
  cctpPaymentAuthorizationDomain,
  cctpPaymentAuthorizationTypes,
  paymentAuthorizationDomain,
  paymentAuthorizationTypes,
} from "@gatopago/shared/payment-authorizations";
import { PAYMENT_NETWORKS } from "@gatopago/shared/payment-networks";

function eip712TypeString(
  primaryType: string,
  fields: readonly { readonly name: string; readonly type: string }[],
): string {
  return `${primaryType}(${fields.map(({ name, type }) => `${type} ${name}`).join(",")})`;
}

describe("Universal Checkout EIP-712 fixtures", () => {
  it("matches the local router vector byte-for-byte", () => {
    const message = {
      intentId: fixture.local.message.intentId as Hex,
      attemptId: fixture.local.message.attemptId as Hex,
      payer: fixture.local.message.payer as Address,
      merchant: fixture.local.message.merchant as Address,
      settlementAmount: BigInt(fixture.local.message.settlementAmount),
      platformFee: BigInt(fixture.local.message.platformFee),
      validAfter: fixture.local.message.validAfter,
      validUntil: fixture.local.message.validUntil,
      metadataHash: fixture.local.message.metadataHash as Hex,
    };
    const domain = {
      ...paymentAuthorizationDomain,
      chainId: fixture.local.domain.chainId,
      verifyingContract: fixture.local.domain.verifyingContract as Address,
    };

    expect(paymentAuthorizationDomain.name).toBe(fixture.local.domain.name);
    expect(paymentAuthorizationDomain.version).toBe(fixture.local.domain.version);
    expect(
      keccak256(
        stringToHex(
          eip712TypeString(
            fixture.local.primaryType,
            paymentAuthorizationTypes.PaymentAuthorization,
          ),
        ),
      ),
    ).toBe(fixture.local.expectedTypeHash);
    expect(
      hashStruct({
        data: message,
        primaryType: "PaymentAuthorization",
        types: paymentAuthorizationTypes,
      }),
    ).toBe(fixture.local.expectedStructHash);
    expect(
      hashTypedData({
        domain,
        message,
        primaryType: "PaymentAuthorization",
        types: paymentAuthorizationTypes,
      }),
    ).toBe(fixture.local.expectedDigest);
  });

  it("matches the CCTP router vector byte-for-byte", () => {
    const message = {
      intentId: fixture.cctp.message.intentId as Hex,
      attemptId: fixture.cctp.message.attemptId as Hex,
      payer: fixture.cctp.message.payer as Address,
      merchant: fixture.cctp.message.merchant as Address,
      settlementChainId: BigInt(fixture.cctp.message.settlementChainId),
      destinationDomain: fixture.cctp.message.destinationDomain,
      settlementAmount: BigInt(fixture.cctp.message.settlementAmount),
      grossPayerAmount: BigInt(fixture.cctp.message.grossPayerAmount),
      platformFee: BigInt(fixture.cctp.message.platformFee),
      maxCctpFee: BigInt(fixture.cctp.message.maxCctpFee),
      minFinalityThreshold: fixture.cctp.message.minFinalityThreshold,
      validAfter: fixture.cctp.message.validAfter,
      validUntil: fixture.cctp.message.validUntil,
      metadataHash: fixture.cctp.message.metadataHash as Hex,
    };
    const domain = {
      ...cctpPaymentAuthorizationDomain,
      chainId: fixture.cctp.domain.chainId,
      verifyingContract: fixture.cctp.domain.verifyingContract as Address,
    };

    expect(cctpPaymentAuthorizationDomain.name).toBe(fixture.cctp.domain.name);
    expect(cctpPaymentAuthorizationDomain.version).toBe(fixture.cctp.domain.version);
    expect(
      keccak256(
        stringToHex(
          eip712TypeString(
            fixture.cctp.primaryType,
            cctpPaymentAuthorizationTypes.CctpPaymentAuthorization,
          ),
        ),
      ),
    ).toBe(fixture.cctp.expectedTypeHash);
    expect(
      hashStruct({
        data: message,
        primaryType: "CctpPaymentAuthorization",
        types: cctpPaymentAuthorizationTypes,
      }),
    ).toBe(fixture.cctp.expectedStructHash);
    expect(
      hashTypedData({
        domain,
        message,
        primaryType: "CctpPaymentAuthorization",
        types: cctpPaymentAuthorizationTypes,
      }),
    ).toBe(fixture.cctp.expectedDigest);
  });

  it("keeps mainnet disabled and pins the configured testnet capabilities", () => {
    expect(Object.keys(PAYMENT_NETWORKS)).toHaveLength(6);
    expect([421614, 84532, 43113].every((chainId) => PAYMENT_NETWORKS[chainId].paymentSource)).toBe(
      true,
    );
    expect([42161, 8453, 43114].every((chainId) => !PAYMENT_NETWORKS[chainId].paymentSource)).toBe(
      true,
    );
    expect(PAYMENT_NETWORKS[421614].localPaymentRouter).toBe(
      "0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4",
    );
    expect(PAYMENT_NETWORKS[421614].cctpPaymentRouter).toBeNull();
    expect(PAYMENT_NETWORKS[84532].cctpPaymentRouter).toBe(
      "0x961C08Bd5a11EFB7264B06d7f14a44FB4d9958Ba",
    );
    expect(PAYMENT_NETWORKS[43113].cctpPaymentRouter).toBe(
      "0xd8289B87b155e8691Da192b12E12E2b592fE7D1E",
    );
    expect(
      [42161, 8453, 43114].every(
        (chainId) =>
          PAYMENT_NETWORKS[chainId].localPaymentRouter === null &&
          PAYMENT_NETWORKS[chainId].cctpPaymentRouter === null,
      ),
    ).toBe(true);
    expect(PAYMENT_NETWORKS[421614].isHomeChain).toBe(true);
    expect(PAYMENT_NETWORKS[84532].cctpFast).toBe(true);
    expect(PAYMENT_NETWORKS[43113].cctpFast).toBe(false);
    expect(PAYMENT_NETWORKS[43114].permitMode).toBe("approve");
  });
});
