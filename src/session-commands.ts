import type { NewMessage } from './types.js';
import { logger } from './logger.js';

const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

export type ModelCommandAction =
  | { type: 'set'; model: string }
  | { type: 'clear' }
  | { type: 'show' }
  | { type: 'invalid'; arg: string };

export function parseModelCommand(text: string): ModelCommandAction | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/model')) return null;
  const rest = trimmed.slice('/model'.length).trim();
  if (rest === '') return { type: 'show' };
  if (rest === 'default') return { type: 'clear' };
  const alias = MODEL_ALIASES[rest.toLowerCase()];
  if (alias) return { type: 'set', model: alias };
  return { type: 'invalid', arg: rest };
}

/**
 * Extract a session slash command from a message, stripping the trigger prefix if present.
 * Returns the slash command (e.g., '/compact', '/model sonnet') or null if not a session command.
 */
export function extractSessionCommand(
  content: string,
  triggerPattern: RegExp,
): string | null {
  let text = content.trim();
  text = text.replace(triggerPattern, '').trim();
  if (text === '/compact') return '/compact';
  if (/^\/model(\s+\S+)?$/.test(text)) return text;
  return null;
}

/**
 * Check if a session command sender is authorized.
 * Allowed: main group (any sender), trusted/admin sender (is_from_me), or owner by sender ID.
 */
export function isSessionCommandAllowed(
  isMainGroup: boolean,
  isFromMe: boolean,
  sender?: string,
  ownerTelegramId?: string,
): boolean {
  if (isMainGroup || isFromMe) return true;
  if (ownerTelegramId && sender && sender === ownerTelegramId) return true;
  return false;
}

/** Minimal agent result interface — matches the subset of ContainerOutput used here. */
export interface AgentResult {
  status: 'success' | 'error';
  result?: string | object | null;
}

/** Dependencies injected by the orchestrator. */
export interface SessionCommandDeps {
  sendMessage: (text: string) => Promise<void>;
  setTyping: (typing: boolean) => Promise<void>;
  runAgent: (
    prompt: string,
    onOutput: (result: AgentResult) => Promise<void>,
  ) => Promise<'success' | 'error'>;
  closeStdin: () => void;
  advanceCursor: (timestamp: string) => void;
  formatMessages: (msgs: NewMessage[], timezone: string) => string;
  /** Whether the denied sender would normally be allowed to interact (for denial messages). */
  canSenderInteract: (msg: NewMessage) => boolean;
  /** Update container_config.model in DB and in-memory group map. */
  updateGroupModel: (model: string | undefined) => Promise<void>;
  /** Delete the agent-runner-src cache directory for the group. */
  clearSessionCache: () => void;
  /** Return the current model override, if any. */
  currentModel: () => string | undefined;
}

async function handleModelCommand(
  action: ModelCommandAction,
  deps: Pick<
    SessionCommandDeps,
    'sendMessage' | 'updateGroupModel' | 'clearSessionCache' | 'currentModel'
  >,
): Promise<void> {
  switch (action.type) {
    case 'show': {
      const current = deps.currentModel();
      await deps.sendMessage(
        current
          ? `Current model: \`${current}\``
          : 'Current model: default (not overridden)',
      );
      return;
    }
    case 'set': {
      if (deps.currentModel() === action.model) {
        await deps.sendMessage(
          `Model is already \`${action.model}\`. No change.`,
        );
        return;
      }
      await deps.updateGroupModel(action.model);
      deps.clearSessionCache();
      await deps.sendMessage(
        `Model updated to \`${action.model}\`.\nSession cache cleared — next message starts a fresh container.`,
      );
      return;
    }
    case 'clear': {
      if (!deps.currentModel()) {
        await deps.sendMessage(
          'Model is already using the default. No change.',
        );
        return;
      }
      await deps.updateGroupModel(undefined);
      deps.clearSessionCache();
      await deps.sendMessage(
        'Model override removed — reverting to default.\nSession cache cleared.',
      );
      return;
    }
    case 'invalid': {
      const available = Object.keys(MODEL_ALIASES).join(', ');
      await deps.sendMessage(
        `Unknown model alias \`${action.arg}\`.\nAvailable: ${available}, default\nExample: \`/model sonnet\``,
      );
      return;
    }
  }
}

function resultToText(result: string | object | null | undefined): string {
  if (!result) return '';
  const raw = typeof result === 'string' ? result : JSON.stringify(result);
  return raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

/**
 * Handle session command interception in processGroupMessages.
 * Scans messages for a session command, handles auth + execution.
 * Returns { handled: true, success } if a command was found; { handled: false } otherwise.
 * success=false means the caller should retry (cursor was not advanced).
 */
export async function handleSessionCommand(opts: {
  missedMessages: NewMessage[];
  isMainGroup: boolean;
  groupName: string;
  triggerPattern: RegExp;
  timezone: string;
  ownerTelegramId?: string;
  deps: SessionCommandDeps;
}): Promise<{ handled: false } | { handled: true; success: boolean }> {
  const {
    missedMessages,
    isMainGroup,
    groupName,
    triggerPattern,
    timezone,
    ownerTelegramId,
    deps,
  } = opts;

  const cmdMsg = missedMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const command = cmdMsg
    ? extractSessionCommand(cmdMsg.content, triggerPattern)
    : null;

  if (!command || !cmdMsg) return { handled: false };

  if (
    !isSessionCommandAllowed(
      isMainGroup,
      cmdMsg.is_from_me === true,
      cmdMsg.sender,
      ownerTelegramId,
    )
  ) {
    // DENIED: send denial if the sender would normally be allowed to interact,
    // then silently consume the command by advancing the cursor past it.
    // Trade-off: other messages in the same batch are also consumed (cursor is
    // a high-water mark). Acceptable for this narrow edge case.
    if (deps.canSenderInteract(cmdMsg)) {
      await deps.sendMessage('Session commands require admin access.');
    }
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  // AUTHORIZED: process pre-compact messages first, then run the command
  logger.info({ group: groupName, command }, 'Session command');

  // Short-circuit for /model — no agent invocation needed
  if (command.startsWith('/model')) {
    const action = parseModelCommand(command);
    if (action) await handleModelCommand(action, deps);
    deps.advanceCursor(cmdMsg.timestamp);
    return { handled: true, success: true };
  }

  const cmdIndex = missedMessages.indexOf(cmdMsg);
  const preCompactMsgs = missedMessages.slice(0, cmdIndex);

  // Send pre-compact messages to the agent so they're in the session context.
  if (preCompactMsgs.length > 0) {
    const prePrompt = deps.formatMessages(preCompactMsgs, timezone);
    let hadPreError = false;
    let preOutputSent = false;

    const preResult = await deps.runAgent(prePrompt, async (result) => {
      if (result.status === 'error') hadPreError = true;
      const text = resultToText(result.result);
      if (text) {
        await deps.sendMessage(text);
        preOutputSent = true;
      }
      // Close stdin on session-update marker — emitted after query completes,
      // so all results (including multi-result runs) are already written.
      if (result.status === 'success' && result.result === null) {
        deps.closeStdin();
      }
    });

    if (preResult === 'error' || hadPreError) {
      logger.warn(
        { group: groupName },
        'Pre-compact processing failed, aborting session command',
      );
      await deps.sendMessage(
        `Failed to process messages before ${command}. Try again.`,
      );
      if (preOutputSent) {
        // Output was already sent — don't retry or it will duplicate.
        // Advance cursor past pre-compact messages, leave command pending.
        deps.advanceCursor(preCompactMsgs[preCompactMsgs.length - 1].timestamp);
        return { handled: true, success: true };
      }
      return { handled: true, success: false };
    }
  }

  // Forward the literal slash command as the prompt (no XML formatting)
  await deps.setTyping(true);

  let hadCmdError = false;
  const cmdOutput = await deps.runAgent(command, async (result) => {
    if (result.status === 'error') hadCmdError = true;
    const text = resultToText(result.result);
    if (text) await deps.sendMessage(text);
  });

  // Advance cursor to the command — messages AFTER it remain pending for next poll.
  deps.advanceCursor(cmdMsg.timestamp);
  await deps.setTyping(false);

  if (cmdOutput === 'error' || hadCmdError) {
    await deps.sendMessage(`${command} failed. The session is unchanged.`);
  }

  return { handled: true, success: true };
}
