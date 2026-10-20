import { ROLE_SECTIONS } from '../src/style-role-prompt.js';

export function roleSections() {
  return ROLE_SECTIONS.map((title, i) => ({ title,
    text: i === 0 ? '简短直接，先听清当前话题，再表达态度；对方愿意展开时追问理由，不机械复读示例。' : '',
    traitIndexes: i === 0 ? [1] : []
  }));
}

export function roleResponse() {
  return { message: { tool_calls: [{ type: 'function', function: {
    name: 'submit_role_prompt', arguments: JSON.stringify({ sections: roleSections() })
  } }] }, usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } };
}
