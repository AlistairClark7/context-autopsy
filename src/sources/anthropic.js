import { classifyTool, looksLikeError } from '../classify.js';
import { makeItem, contentText, shortCommand, basename } from './common.js';

/**
 * Turns one Anthropic-style message ({ role, content: string | blocks }) into
 * context items. Several agents store their history this way. `calls` links
 * tool_use ids to their classification across messages.
 */
export function anthropicMessageItems(m, calls, { mapTool = (n) => n } = {}) {
  const out = [];
  const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
  for (const b of blocks) {
    if (!b) continue;
    if (m.role === 'assistant') {
      if (b.type === 'text') out.push(makeItem(b.text, { category: 'conversation', sub: 'assistant reply', role: 'assistant' }));
      else if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push(makeItem(b.thinking || b.data || '', { category: 'thinking', sub: 'thinking', role: 'assistant', scanSecrets: false }));
      else if (b.type === 'tool_use') {
        const cls = classifyTool(mapTool(b.name), b.input);
        const label = cls.command ? shortCommand(cls.command, cls.keyword) : cls.path ? basename(cls.path) : b.name;
        calls.set(b.id, { ...cls, label });
        out.push(makeItem(b.input, { ...cls, role: 'tool_call', label }));
      }
    } else if (b.type === 'tool_result') {
      const tool = calls.get(b.tool_use_id) || { category: 'other', sub: 'tool', label: b.name || 'tool' };
      const { text, images } = contentText(b.content);
      out.push(makeItem(text, { ...tool, role: 'tool_result', images, isError: !!b.is_error || (tool.command != null && looksLikeError(text)) }));
    } else if (b.type === 'text') {
      const injected = /^\s*<(system-reminder|environment_details|SYSTEM_NOTICE)/.test(b.text || '');
      out.push(makeItem(b.text, injected ? { category: 'overhead', sub: 'injected context', role: 'harness' } : { category: 'conversation', sub: 'your prompts', role: 'user' }));
    } else if (b.type === 'image') {
      out.push(makeItem('', { category: 'conversation', sub: 'your images', role: 'user', images: 1 }));
    } else if (b.type === 'file' || b.type === 'document') {
      out.push(makeItem(b.content ?? '', { category: 'code_read', sub: 'attached files', role: 'user' }));
    }
  }
  return out;
}

/** Full prompt size from Anthropic-style usage fields, whatever they're called. */
export function anthropicRequest(u) {
  if (!u) return null;
  const input = u.input_tokens ?? u.inputTokens ?? 0;
  const read = u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? u.cacheReadTokens ?? 0;
  const write = u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? u.cacheWriteTokens ?? 0;
  const total = u.totalInputTokens ?? null;
  const contextTokens = total || input + read + write;
  if (!contextTokens) return null;
  return { t: 'request', contextTokens, outputTokens: u.output_tokens ?? u.outputTokens ?? 0, input, cacheRead: read, cacheWrite: write };
}
