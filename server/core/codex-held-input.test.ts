import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as client from '../herdr/client.ts';
import type { HerdrPane } from '../../shared/protocol.ts';
import { createSubmitText } from './composer.ts';
import { codexInputHeld } from '../dialogs/codex.ts';
import { registry } from '../dialogs/registry.ts';
import * as opencode from '../opencode-native.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  'such a wrapped row, the footer gone': ['› a draft', '  GPT-6-Astra ultra · /fixture ·', '  esc back'],
  'a draft with a status-shaped line over key hints': ['› note', '  gpt default · test', '  enter select · esc back', STATUS],
  // a list never draws under the status row: its keys there are a folder or thread name wrapped onto the next row
  'a status row wrapped onto a list\'s keys': ['› Ask Codex to do anything', '  GPT-6-Astra ultra · /fixture ·', '  enter select · esc back'],
  // the transcript view's row is the screen's last: a draft row reading so has the status row under it
  'a draft row reading as the transcript view': ['› Please explain', '  Browsing the repository', STATUS, ROWS],
  'such a row at 40 columns': ['› Ask Codex to do anything', '  GPT-6-Astra ultra · /home/u… ·', '  enter select · esc back', '  ← for agents · ? for shortcuts'],
};
// /statusline in a narrow pane wraps its hints, the separator left at the end of the first row
// a folder whose name ends in the separator ends the status row in it: the transcript view's keys under it still hold
HELD['the transcript view in a folder named with a separator'] = ['» Ask Codex to do anything', '  GPT-6.1-Sol default · ~/dir ·', 'Browsing transcript · ↑↓/jk scroll · ←→/hl prompts · ^t details · ↵ rewind · esc back'];
// /statusline's keys broken between rows, the separator starting the next one
HELD['/statusline wrapped before its separator'] = ['Configure Status Line', '› [x] model', '↓', '  GPT-6-Astra ultra · /fixture', '', '  enter save', '  · esc cancel'];
HELD['/statusline at 16 columns'] = ['Configure Status', '› [x] model', '↓', '  m low · /fixt…', '', '  enter save ·', '  esc cancel'];
// a list's screen whose last row reads as the composer's footer: the footer is the composer's only under its status row
HELD['a list over a footer-shaped row'] = [...HELD['/permissions']!, ROWS];
const screen = (rows: string[]) => ['  >_ OpenAI Codex (v0.166.0)', '     /fixture', '', ...rows, '', ''].join('\n');

describe('codexInputHeld', () => {
  for (const [name, rows] of Object.entries(HELD)) it(`holds under ${name}`, () => expect(codexInputHeld(screen(rows))).toBe(true));
  for (const [name, rows] of Object.entries(FREE)) it(`is free with ${name}`, () => expect(codexInputHeld(screen(rows))).toBe(false));
  it('reads divider rows and colour as nothing', () => expect(codexInputHeld(`\u001b[1mSelect Model\u001b[0m\n  \u001b[2menter select\u001b[0m · \u001b[2mesc back\u001b[0m\n${'─'.repeat(40)}\n`)).toBe(true));
});

// Codex 0.167's own screens as herdr's pane.read gave them at 80, 40 and 15 columns (paths renamed): a narrow pane
// wraps the keys between words and cuts the status row and the footer short
describe('codexInputHeld on recorded Codex 0.167 screens', () => {
  const recorded = (name: string, cols: number) => readFileSync(join(import.meta.dir, '..', 'fixtures', `codex-held-0.167.0-${name}-${cols}.txt`), 'utf8');
  for (const cols of [80, 40, 15]) {
    for (const name of ['statusline', 'permissions', 'transcript']) it(`holds under ${name} at ${cols} columns`, () => expect(codexInputHeld(recorded(name, cols))).toBe(true));
    it(`is free at the composer at ${cols} columns`, () => expect(codexInputHeld(recorded('idle', cols))).toBe(false));
  }
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

  it('reads the screen last: a list opened during the other awaits of the send gets nothing', async () => {
    const { read, prompt, typed, keys } = spies(FREE['its composer']!);
    // /permissions opens while the send waits on its other lookups, after any earlier look at the screen
    spyOn(opencode, 'openCodeSkillsToType').mockImplementation(async (_pane, sent) => {
      read.mockResolvedValue({ text: screen(HELD['/permissions']!) } as Awaited<ReturnType<typeof client.paneRead>>);
      return { sent, skills: [] };
    });
    const failed = await submitter()(pane.pane_id, 'hello', 'hello', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('agent_blocked');
    expect(prompt).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it('sends no Enter past a collapsed queue once one of its screens opened over the paste', async () => {
    const queue = ['• Queued follow-up inputs', '  ? 1 question', '    alt+↑ to answer'];
    const { read, prompt, typed, keys } = spies([...queue, ...FREE['its composer']!]);
    spyOn(client, 'paneGet').mockResolvedValue({ ...pane, agent_status: 'blocked' });
    prompt.mockRejectedValue(new client.HerdrError('agent_blocked', 'blocked'));
    // /permissions opens once the paste is in
    typed.mockImplementation(async () => { read.mockResolvedValue({ text: screen(HELD['/permissions']!) } as Awaited<ReturnType<typeof client.paneRead>>); });
    const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('submit_partial');
    expect(typed).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  it('reads a failed look after the paste past a collapsed queue as not confirmed, with no Enter', async () => {
    const queue = ['• Queued follow-up inputs', '  ? 1 question', '    alt+↑ to answer'];
    const { read, prompt, typed, keys } = spies([...queue, ...FREE['its composer']!]);
    spyOn(client, 'paneGet').mockResolvedValue({ ...pane, agent_status: 'blocked' });
    prompt.mockRejectedValue(new client.HerdrError('agent_blocked', 'blocked'));
    // herdr stops answering once the paste is in
    typed.mockImplementation(async () => { read.mockRejectedValue(new client.HerdrError('connect_failed', 'cannot reach herdr')); });
    const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('submit_partial');
    expect(typed).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  // typed raw past agent.prompt, also nothing into what herdr has not yet reported blocked: an approval, a masked prompt
  const APPROVAL = ['Would you like to run the following command?', '', '$ rm -rf junk', '', '› 1. Yes, proceed (y)', '  2. No, and tell Codex what to do differently (esc)', '', 'Press enter to confirm or esc to cancel'];
  const PASSPHRASE = ['› Ask Codex to do anything', STATUS, "Enter passphrase for key '/tmp/key':"];
  for (const [name, rows] of [['an approval', APPROVAL], ['a masked prompt', PASSPHRASE]] as const) {
    it(`types nothing raw once agent.prompt is refused and ${name} came up`, async () => {
      const { read, prompt, typed, keys } = spies(FREE['its composer']!);
      prompt.mockImplementation(async () => {
        read.mockResolvedValue({ text: screen([...rows]) } as Awaited<ReturnType<typeof client.paneRead>>);
        throw new client.HerdrError('agent_not_ready', 'refused');
      });
      const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
      expect((failed as client.HerdrError | null)?.code).toBe('agent_blocked');
      expect(typed).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
    });
  }
  it('hands agent.prompt nothing while an approval herdr still reports at rest is up', async () => {
    const { prompt, typed, keys } = spies(APPROVAL);
    const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('agent_blocked');
    expect(prompt).not.toHaveBeenCalled();
    expect(typed).not.toHaveBeenCalled();
    expect(keys).not.toHaveBeenCalled();
  });

  it('sends no raw Enter into an approval that came up over the paste', async () => {
    const { read, prompt, typed, keys } = spies(FREE['its composer']!);
    prompt.mockRejectedValue(new client.HerdrError('agent_not_ready', 'refused'));
    typed.mockImplementation(async () => { read.mockResolvedValue({ text: screen(APPROVAL) } as Awaited<ReturnType<typeof client.paneRead>>); });
    const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
    expect((failed as client.HerdrError | null)?.code).toBe('submit_partial');
    expect(typed).toHaveBeenCalledTimes(1);
    expect(keys).not.toHaveBeenCalled();
  });

  for (const code of ['agent_not_ready', 'agent_not_found'] as const) {
    it(`types nothing raw once agent.prompt is refused with ${code} and one of its screens opened`, async () => {
      const { read, prompt, typed, keys } = spies(FREE['its composer']!);
      // herdr no longer names or knows the agent, and /permissions is up by then
      prompt.mockImplementation(async () => {
        read.mockResolvedValue({ text: screen(HELD['/permissions']!) } as Awaited<ReturnType<typeof client.paneRead>>);
        throw new client.HerdrError(code, 'refused');
      });
      const failed = await submitter()(pane.pane_id, 'Carry on', 'Carry on', Date.now()).then(() => null, (error: unknown) => error);
      expect((failed as client.HerdrError | null)?.code).toBe('agent_blocked');
      expect(typed).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
    });
  }

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
