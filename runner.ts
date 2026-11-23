
const [checkout, state] = process.argv.slice(2);
const { claudeApprovals } = await import(`${checkout}/server/approvals/claude.ts`);
if (claudeApprovals.turn) {
  const turn = claudeApprovals.turn;
  claudeApprovals.turn = (event: unknown) => { const told = turn(event); if (told) console.log(JSON.stringify({ hookTurn: told, at: Date.now() })); return told; };
}
const toCard = claudeApprovals.toCard;
claudeApprovals.toCard = (event: unknown) => { const card = toCard(event); console.log(JSON.stringify({ hookCard: (event as { tool_name?: string }).tool_name, bound: card !== null, at: Date.now() })); return card; };
const { createServer } = await import(`${checkout}/server/index.ts`);
const bridge = createServer({ hostname: "127.0.0.1", ipv6Loopback: false, port: Number(process.env.QA_PORT ?? 0), stateDir: state, siblingStateDir: null, registerBridge: false, machines: false, system: null, tailscaleOwner: null, tailscaleBinary: null });
console.log(`QA_PORT=${bridge.port}`);
