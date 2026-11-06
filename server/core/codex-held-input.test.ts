import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as client from '../herdr/client.ts';
import type { HerdrPane } from '../../shared/protocol.ts';
import { createSubmitText } from './composer.ts';
import { codexInputHeld } from '../dialogs/codex.ts';
import { registry } from '../dialogs/registry.ts';

// herdr reports Codex at rest under its own lists and fields, so a message for its composer would be pasted into them: the
// paste is dropped, and the Enter after it takes the row under the cursor (saving a model as the default for every new
// session), or in the transcript view rewinds the conversation. These are Codex 0.166's own rows, typed here by hand;
// nothing was said in them.
const STATUS = '  GPT-6-Astra ultra · /fixture';
const ROWS = '  ← for agents · ? for shortcuts';
const HELD: Record<string, string[]> = {
  '/model': ['Select Model and Effort', '  1. GPT-6.1-Sol            Latest workhorse model.', '› 2. GPT-6-Astra (current)  Frontier intelligence.', '↓', '  enter select · esc back'],
  'its levels': ['Select Reasoning Level for GPT-6-Astra', '› 4. Extra high (current)  Extra high reasoning depth', '  5. More reasoning…       Max and Ultra', '', '  enter default · s session · esc back'],
  'its levels at Ultra': ['Select Reasoning Level for GPT-6-Astra', '› 5. More reasoning… (current)  Max and Ultra', '', '  enter select · esc back'],
  'its advanced levels': ['Advanced Reasoning', '  1. Max', '› 2. Ultra (current)', '', '  enter apply · s session · esc back'],
  '/permissions': ['Update Model Permissions', '› 1. Read Only', '  2. Auto', '', '  enter select · esc back'],
  '/review': ['Select a review preset', '› 1. Review against a base branch', '', '  enter select · esc back'],
  '/theme': ['Select Syntax Theme', '› catppuccin-latte (current)', '↓', '', '  enter select · esc back'],
  '/statusline': ['Configure Status Line', '› [x] model-with-reasoning', '↓', '  GPT-6-Astra ultra · /fixture · a thread', '', '  space toggle · ←/→ reorder · enter save · esc cancel'],
  '/resume': ['Resume a previous session', '› Yesterday', '', ' enter resume   esc exit   ^c exit   tab focus sort/filter   ←/→ change option', ' ^o comfortable view   ^t transcript   ^e expand   ↑/↓ browse'],
  '/rename': ['Name thread', '› Type a name and press Enter', '', '  enter submit · esc back'],
  '/experimental': ['Experimental features', '› [ ] Something new', '', '  space toggle · enter save · esc save/close'],
  '/agent': ['Agents', '› main', '', '  ? help  esc back  ↑/↓ move  enter open  n new'],
  'the transcript view': ['» Ask Codex to do anything', STATUS, 'Browsing transcript · ↑↓/jk scroll · ←→/hl prompts · ^t details · ↵ rewind · esc back'],
  '/diff': ['diff --git a/a b/a', '+a line', '', '  q close'],
  'a folder not trusted yet': ['Do you trust the contents of this directory?', '› 1. Yes', '', '  enter continue · esc back'],
};
const FREE: Record<string, string[]> = {
  'its composer': ['› Ask Codex to do anything', STATUS, ROWS],
  'its composer at Ultra': ['» Ask Codex to do anything', STATUS, ROWS],
  'an empty one': ['»', STATUS, ROWS],
  'a thread named as a key': ['› Ask Codex to do anything', '  GPT-6-Astra xhigh · /fixture · esc back', ROWS],
  'a thread named so, the footer gone': ['› a draft', '  GPT-6-Astra ultra fast · /fixture · enter select'],
  'such a thread on a model with a space in its name': ['› Ask Codex to do anything', '  GPT-6.1 Terra xhigh · /fixture · esc back', ROWS],
  'one in the folder': ['› Ask Codex to do anything', '  GPT-6-Astra default · ~/esc back · Main [default]', ROWS],
  'a draft of the words': ['» esc back', STATUS, ROWS],
  'a draft of them, the footer gone': ['» enter select · esc back', STATUS],
  'a working turn': ['• Working (1s • esc to interrupt)', '', '› Ask Codex to do anything', STATUS, ROWS],
  'an answer quoting a list': ['• Press these:', '  enter select · esc back', '', '› Ask Codex to do anything', STATUS, ROWS],
  'a warning beside the footer': ['› Ask Codex to do anything', STATUS, '  ← for agents · ? for shortcuts            ⚠ 1 warning · f2 to view'],
  'a blank screen': [''],
  'a draft whose last line reads as keys, the footer gone': ['» Please follow these steps', '  enter select · esc back', STATUS],
  'a status row wrapped onto a thread named as a key': ['› Ask Codex to do anything', '  GPT-6-Astra ultra · /fixture ·', '  esc back', ROWS],
};
const screen = (rows: string[]) => ['  >_ OpenAI Codex (v0.166.0)', '     /fixture', '', ...rows, '', ''].join('\n');

describe('codexInputHeld', () => {
  for (const [name, rows] of Object.entries(HELD)) it(`holds under ${name}`, () => expect(codexInputHeld(screen(rows))).toBe(true));
  for (const [name, rows] of Object.entries(FREE)) it(`is free with ${name}`, () => expect(codexInputHeld(screen(rows))).toBe(false));
  it('reads divider rows and colour as nothing', () => expect(codexInputHeld(`\u001b[1mSelect Model\u001b[0m\n  \u001b[2menter select\u001b[0m · \u001b[2mesc back\u001b[0m\n${'─'.repeat(40)}\n`)).toBe(true));
});

describe('registry.holdsInput', () => {
  it('is for Codex alone: the other agents keep what their own readers say', () => {
    const list = screen(HELD['/permissions']!);
    expect(registry.holdsInput('codex', list)).toBe(true);
    for (const agent of ['pi', 'claude', 'omp']) expect(registry.holdsInput(agent, list)).toBe(false);
  });
  it('keeps upstream\'s card for a Codex list: the guard is not one of its waits', () => {
    expect(registry.waits('codex', screen(HELD['/permissions']!))).toBe(false);
  });
});

describe('a message sent to a Codex pane', () => {
  const pane: HerdrPane = { pane_id: 'codex-held', workspace_id: 'w', tab_id: 't', terminal_id: 'terminal',
    cwd: '/fixture', focused: false, revision: 0, agent: 'codex', agent_status: 'idle' };
  const submitter = () => createSubmitText({
    options: { submitDelayMs: 0 }, lastTyped: new Map(), attachments: new Map(), terminalAttach: async () => true,
    SUBMIT_DEADLINE_MS: 1000, TYPED_SETTLE_MS: 0, DRAFT_CLEAR_WAIT_MS: 0, DRAFT_CLEAR_POLL_MS: 0, SUBMIT_DELAY_MS: 0,
  });
  beforeEach(() => spyOn(client, 'paneProcessInfo').mockResolvedValue(undefined));
  afterEach(() => mock.restore());
  const spies = (rows: string[], agent = 'codex') => {
    spyOn(client, 'paneGet').mockResolvedValue({ ...pane, agent });
    return {
      read: spyOn(client, 'paneRead').mockResolvedValue({ text: screen(rows) } as Awaited<ReturnType<typeof client.paneRead>>),
      prompt: spyOn(client, 'agentPrompt').mockResolvedValue(),
      typed: spyOn(client, 'paneSendText').mockResolvedValue(),
      keys: spyOn(client, 'paneSendKeys').mockResolvedValue(),
    };
  };

  it('is refused under any of its screens, with nothing typed', async () => {
    for (const [name, rows] of Object.entries(HELD)) {
      const { prompt, typed, keys } = spies(rows);
      const failed = await submitter()(pane.pane_id, 'Carry on without me', 'Carry on without me', Date.now()).then(() => null, (error: unknown) => error);
      expect([name, (failed as client.HerdrError | null)?.code]).toEqual([name, 'agent_blocked']);
      expect(prompt).not.toHaveBeenCalled();
      expect(typed).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
      mock.restore();
      spyOn(client, 'paneProcessInfo').mockResolvedValue(undefined);
    }
  });

  it('types nothing past a collapsed queue once one of its screens opened over it', async () => {
    const queue = ['• Queued follow-up inputs', '  ? 1 question', '    alt+↑ to answer'];
    const { read, prompt, typed, keys } = spies([...queue, ...FREE['its composer']!]);
    spyOn(client, 'paneGet').mockResolvedValue({ ...pane, agent_status: 'blocked' });
    prompt.mockRejectedValue(new client.HerdrError('agent_blocked', 'blocked'));
    // free when first read; the transcript view opened before the refusal's own look
    read.mockResolvedValueOnce({ text: screen([...queue, ...FREE['its composer']!]) } as Awaited<ReturnType<typeof client.paneRead>>)
      .mockResolvedValue({ text: screen([...queue, ...HELD['the transcript view']!]) } as Awaited<ReturnType<typeof client.paneRead>>);
    const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('agent_blocked');
    expect(typed).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it('goes to the agent at its composer', async () => {
    const { prompt } = spies(FREE['its composer at Ultra']!);
    await submitter()(pane.pane_id, 'Carry on without me', 'Carry on without me', Date.now());
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('reads no screen for another agent', async () => {
    const { prompt, read } = spies(HELD['/permissions']!, 'pi');
    await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now());
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves the terminal\'s own input line alone: there it stands in for the keyboard', async () => {
    const { read } = spies(HELD['/permissions']!);
    await submitter()(pane.pane_id, 'j', 'j', Date.now(), true);
    expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ source: 'detection', paneId: pane.pane_id }));
  });
});
