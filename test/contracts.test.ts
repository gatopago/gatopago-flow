import { describe, expect, it } from 'vitest';
import { parsePaymentJobMessage, isSettlementAccountCommand, isReserveWalletPaymentAttemptCommand,
 isRegisterWalletPaymentExecutionCommand } from '@gatopago/shared/payment-contracts';
import { PaymentCommands } from '../src/commands';
import type { Bindings } from '../src/env';

const claim = { service: 'gatopago-wallet-core', requestId: 'req-1', userId: 'usr_00000000-0000-4000-8000-000000000001' };
const base = { contractVersion: 3, commandId: 'cmd-1', claim };
const address = `0x${'11'.repeat(20)}`;
const settlement = { ...base, accountVersion: 1, chainId: 421614, walletAddress: address };
const reserve = { ...base, linkId: 'link-1', payerAddress: address, sourceChainId: 421614, requestedRoute: 'local' };
const register = { ...base, attemptId: 'attempt-1', userOpHash: `0x${'22'.repeat(32)}`, sourceChainId: 421614 };
const job = { messageVersion: 2, job: 'webhook_delivery', jobId: 'job-1', dedupeKey: 'job-1', resourceId: 'event-1',
 partition: '421614', attempt: 0, createdAt: '2026-08-24T12:00:00.000Z' };

describe('current Flow wire contracts', () => {
 it('accepts a complete current job without conversion', () => { expect(parsePaymentJobMessage(job)).toEqual(job); });
 it.each([undefined, 0, 1, 3])('rejects queue version %s', version => {
  expect(parsePaymentJobMessage({ ...job, messageVersion: version })).toBeNull();
 });
 it('rejects incomplete jobs and unimplemented runners', () => {
  expect(parsePaymentJobMessage({ ...job, dedupeKey: undefined })).toBeNull();
  expect(parsePaymentJobMessage({ ...job, job: 'webhook_key_rotation' })).toBeNull();
 });
 it('accepts only current commands with explicit identity, idempotency and network', () => {
  expect(isSettlementAccountCommand(settlement)).toBe(true);
  expect(isReserveWalletPaymentAttemptCommand(reserve)).toBe(true);
  expect(isRegisterWalletPaymentExecutionCommand(register)).toBe(true);
  for (const [parse, command] of [[isSettlementAccountCommand, settlement],
   [isReserveWalletPaymentAttemptCommand, reserve], [isRegisterWalletPaymentExecutionCommand, register]] as const) {
   for (const invalid of [null, {}, { ...command, contractVersion: 1 }, { ...command, contractVersion: 2 }, { ...command, contractVersion: 4 },
    { ...command, commandId: '' }, { ...command, claim: { ...claim, service: 'gatopago-app-api' } }]) {
    expect(parse(invalid)).toBe(false);
   }
  }
  expect(isReserveWalletPaymentAttemptCommand({ ...reserve, sourceChainId: undefined })).toBe(false);
 expect(isSettlementAccountCommand({ ...settlement, chainId: undefined })).toBe(false);
 });
 it.each([
  { service: claim.service, requestId: claim.requestId, uid: claim.userId },
  { ...claim, userId: 'firebase-user' },
  { ...claim, uid: claim.userId },
 ])('rejects provider identities and ambiguous claims before storage access: %j', async invalidClaim => {
  const commands = new PaymentCommands({} as Bindings);
  for (const [parse, command] of [[isSettlementAccountCommand, settlement],
   [isReserveWalletPaymentAttemptCommand, reserve], [isRegisterWalletPaymentExecutionCommand, register]] as const) {
   expect(parse({ ...command, claim: invalidClaim })).toBe(false);
  }
  expect(await commands.upsertSettlementAccount({ ...settlement, claim: invalidClaim } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
  expect(await commands.reserveWalletPaymentAttempt({ ...reserve, claim: invalidClaim } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
  expect(await commands.registerWalletPaymentExecution({ ...register, claim: invalidClaim } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
 });
 it('rejects retired RPC input before touching storage or providers', async () => {
  const commands = new PaymentCommands({} as Bindings);
  expect(await commands.upsertSettlementAccount({ ...settlement, contractVersion: 1 } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
  expect(await commands.reserveWalletPaymentAttempt({ ...reserve, contractVersion: 1 } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
  expect(await commands.registerWalletPaymentExecution({ ...register, contractVersion: 1 } as never))
   .toMatchObject({ ok: false, error: 'INVALID_CONTRACT' });
 });
});
