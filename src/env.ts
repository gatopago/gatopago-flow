import type { PaymentJobMessage } from "@gatopago/shared/payment-contracts";

type OptionalBindingKey =
  | "ALLOWED_ORIGINS"
  | "OPS_HEALTH_TOKEN"
  | "PAYMENT_ROUTER_PREFLIGHT_ENABLED"
  | "PAYMENT_FEE_POLICY_JSON"
  | "PAYMENT_PLATFORM_FEE_RECIPIENT"
  | "PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY"
  | "PAYMENT_RPC_URLS"
  | "PAYMENT_RELAYER_PRIVATE_KEY"
  | "PAYMENT_CONFIRMATIONS_JSON"
  | "CIRCLE_API_KEY"
  | "WEBHOOK_SECRET_ENCRYPTION_KEY"
  | "WEBHOOK_SECRET_ENCRYPTION_KEY_ID"
  | "WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS"
  | "PAYMENT_LIVE_ENABLED";

type StringBindingKey = {
  [Key in keyof CloudflareBindings]-?: CloudflareBindings[Key] extends string ? Key : never;
}[keyof CloudflareBindings];

type OptionalInfrastructureBinding =
  "PAYMENT_JOBS_QUEUE" | "PAYMENT_JOB_SCHEDULER" | "WALLET_IDENTITY";

export type Bindings = Omit<CloudflareBindings, StringBindingKey | OptionalInfrastructureBinding> &
  Record<Exclude<StringBindingKey, OptionalBindingKey>, string> &
  Partial<Record<OptionalBindingKey, string>> & {
    PAYMENT_JOBS_QUEUE?: Queue<PaymentJobMessage>;
    PAYMENT_JOB_SCHEDULER?: CloudflareBindings["PAYMENT_JOB_SCHEDULER"];
    WALLET_IDENTITY?: Pick<CloudflareBindings["WALLET_IDENTITY"], "fetch">;
  };
