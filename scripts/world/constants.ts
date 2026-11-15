export class PlanError extends Error {
  constructor(message: string) { super(message); this.name = "PlanError"; }
}

export const PORTS = { relay: 8787, account: 9080, control: 9090, tlsRelay: 8443, tlsAccount: 9443, tlsStaging: 443, server: 17611 } as const;
