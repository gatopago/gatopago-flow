export class WorkerEntrypoint<Env = unknown> {
	protected env: Env;
	protected ctx: ExecutionContext;
	constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
}

export class DurableObject<Env = unknown> {
	protected env: Env;
	protected ctx: DurableObjectState;
	constructor(ctx: DurableObjectState, env: Env) { this.ctx = ctx; this.env = env; }
}
