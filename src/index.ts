import { WorkerEntrypoint } from 'cloudflare:workers';
import { PAYMENTS_CONTRACT_VERSION, type PaymentsRpcService, type SettlementAccountCommand,
 type ReserveWalletPaymentAttemptCommand, type RegisterWalletPaymentExecutionCommand } from '@gatopago/shared/payment-contracts';
import type { Bindings } from './env';
import app from './http';
import { PaymentCommands } from './commands';
import { runMaintenance } from './maintenance';
import { consumeFlowQueue } from './services/jobs';

export default class FlowWorker extends WorkerEntrypoint<Bindings> implements PaymentsRpcService {
 override fetch(request: Request): Promise<Response> {
  return Promise.resolve(app.fetch(request, this.env, this.ctx));
 }
 contractVersion() { return PAYMENTS_CONTRACT_VERSION; }
 upsertSettlementAccount(command: SettlementAccountCommand) {
  return new PaymentCommands(this.env).upsertSettlementAccount(command);
 }
 reserveWalletPaymentAttempt(command: ReserveWalletPaymentAttemptCommand) {
  return new PaymentCommands(this.env).reserveWalletPaymentAttempt(command);
 }
 registerWalletPaymentExecution(command: RegisterWalletPaymentExecutionCommand) {
  return new PaymentCommands(this.env).registerWalletPaymentExecution(command);
 }
 override async queue(batch: MessageBatch<unknown>): Promise<void> {
  await consumeFlowQueue(batch, this.env);
 }
 override async scheduled(): Promise<void> { await runMaintenance(this.env); }
}
export { PaymentJobScheduler } from './services/jobScheduler';
