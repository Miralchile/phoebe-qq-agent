// Local experiment: keep QQ-agent's group scheduler; carry over Phoebe's contracts.
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig, DATA_DIR } from './config.js';
import { registerTool } from './tool-registry.js';
import { groupStickerPool } from './group-stickers.js';
import { styleMode } from './style-profiles.js';

const isAdmin = id => (getConfig().phoebe?.adminIds || []).map(String).includes(String(id));
const KEYWORDS = /菲比|菲八|啾比|团子/;
const PHOEBE = /菲比|菲八|啾比/;
const ANGER = new Set([139, 140, 245, 334, 364, 528, 539, 838, 994, 1111]);
const CORE = [218, 364, 245, 282, 283, 367, 458, 222, 253, 139, 838, 95, 113, 405, 448, 380, 529, 256];
const state = new Map();
const decisions = new Map();
let nextRandom = 0;
let library;
let names;
const enabled = () => getConfig().phoebe?.enabled === true;
const jsonFile = (name) => path.join(DATA_DIR, name);
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}
function loadNames() {
  if (!names) names = JSON.parse(fs.readFileSync(jsonFile('phoebe-names.json'), 'utf8'));
  return names;
}
function memes() {
  if (!library) library = JSON.parse(fs.readFileSync(jsonFile('phoebe-catalog.json'), 'utf8'));
  return library;
}
function chatState(chatKey) {
  if (!state.has(chatKey)) state.set(chatKey, { lastReply: 0, recent: [], candidates: [], sources: new Set(), linksRequested: false });
  return state.get(chatKey);
}
function settings(chatKey) {
  return getConfig().phoebe.groups[String(chatKey).split(':')[1]];
}

export function phoebeReplyRequired(ctx) {
  return enabled() && (ctx.kind === 'private' || ctx.chatKey.startsWith('private:')
    || ctx.triggerEntries.some(e => e.atMe === true
      || (ctx.selfId && String(e.reply?.senderId) === String(ctx.selfId))));
}

export function phoebeBeforeTool(ctx, name) {
  if (name === 'finish' && phoebeReplyRequired(ctx) && !ctx.session.sent.some(s => s.type === 'text')) {
    throw new Error('本轮是明确@你、引用你或私聊，必须先用send_message回应；不能因显示昵称不同当作在叫别人。只有@没有正文时，可以简短询问对方有什么事。');
  }
}

export function observePhoebe(chatKey, entry) {
  if (!enabled() || entry.self) return;
  const all = loadNames();
  const group = all[chatKey] ||= {};
  const person = group[entry.senderId] ||= { names: [], aliases: [] };
  if (entry.senderName && !person.names.includes(entry.senderName)) person.names.push(entry.senderName);
  const alias = /(?:以后)?(?:请)?叫我[「“"]?([\p{L}\p{N}_]{1,12})(?:[」”"]|[，。！!\s]|$)/u.exec(entry.text);
  if (alias && !person.aliases.includes(alias[1])) person.aliases.push(alias[1]);
  writeJson(jsonFile('phoebe-names.json'), all);
}

export function phoebeTrigger({ chatKey, triggerEntries, selfId, isPrivate, roll = null, now = Date.now() }) {
  if (!enabled()) return null;
  const count = getConfig().store.historyCount;
  if (isPrivate) return { tier: 1, count, reason: '私聊', shouldRespond: true };
  const cfg = settings(chatKey);
  if (!cfg) return { tier: 0, count: 0, reason: '非测试群', shouldRespond: false };
  const result = (yes, reason, tier = 3) => ({ tier: yes ? tier : 0, count: yes ? count : 0, reason, shouldRespond: yes });
  // The native scheduler asks twice (ingress and batch start). Reuse the same draw.
  for (const e of triggerEntries) {
    if (e.atMe || String(e.reply?.senderId) === String(selfId)) return result(true, '被@或引用', 1);
    const old = decisions.get(`${chatKey}:${e.id}`);
    if (old?.shouldRespond) return old;
  }
  for (const e of triggerEntries) {
    const key = `${chatKey}:${e.id}`;
    if (decisions.has(key)) continue;
    let r;
    const s = chatState(chatKey);
    const age = s.lastReply ? now - s.lastReply : Infinity;
    if (e.senderId === '10004' || e.senderId === String(selfId) || e.atNames?.length || e.reply
        || /^\s*\//.test(e.text) || /https?:\/\//i.test(e.text) || !e.text.replace(/\[[^\]]*\]/g, '').trim()) {
      r = result(false, '非聊天机会');
    } else if (age < 8000) {
      r = result(false, '回复后短间隔');
    } else if (age <= 90000 && PHOEBE.test(e.text)) {
      r = result(true, '近期讨论菲比，模型判断是否续聊');
    } else if (now < nextRandom) {
      r = result(false, '随机接话冷却');
    } else {
      const p = KEYWORDS.test(e.text) ? cfg.keyword_probability : cfg.random_probability;
      const probability = PHOEBE.test(e.text) && age <= 600000 ? cfg.recent_keyword_probability : p;
      const hit = (roll ?? Math.random() * 100) < probability * 100;
      r = result(hit, `概率${Math.round(probability * 100)}%`);
      if (hit) nextRandom = now + cfg.cooldown_seconds * 1000;
    }
    decisions.set(key, r);
    if (r.shouldRespond) return r;
  }
  if (decisions.size > 1000) for (const k of [...decisions.keys()].slice(0, 500)) decisions.delete(k);
  return result(false, '未触发');
}

export function phoebeContext(ctx) {
  const recent = ctx.store.recent(ctx.chatKey, { limit: 80 });
  const text = ctx.triggerEntries.map(e => e.text).join('\n');
  const s = chatState(ctx.chatKey);
  s.sources = new Set();
  s.linksRequested = !/(?:不用|不要|无需|不必).{0,6}(?:链接|来源|网址)/.test(text) && /(?:给|发|贴|提供|附|要|找).{0,12}(?:链接|网址|来源)|(?:来源|链接|网址).{0,8}(?:给|发|贴|哪|呢|吗)|https?:\/\//.test(text);
  const cleanText = text.replace(/菲比|菲八|啾比/g, '');
  const tokens = [...new Set(cleanText.match(/[\p{Script=Han}]{2,}/gu) || [])];
  const ranked = memes().filter(m => !s.recent.includes(m.id)).map(m => ({ m, score: tokens.reduce((n, t) => n + (m.title.includes(t) ? 5 : 0) + [...t].filter(ch => m.title.includes(ch)).length, 0) + (ANGER.has(m.id) && /菲八|生气|笨蛋|抢|揍|愤怒/.test(text) ? 20 : 0) }));
  ranked.sort((a,b) => b.score - a.score || a.m.id - b.m.id);
  const ids = [...new Set([...ranked.filter(x => x.score > 0 && !/看片|黄文|调教|屁股|借token贷/.test(x.m.title)).slice(0, 12).map(x => x.m.id), ...ANGER, ...CORE])].filter(id => !s.recent.includes(id));
  s.candidates = ids;
  const people = loadNames()[ctx.chatKey] || {};
  const present = new Set(recent.filter(e => !e.self).map(e => e.senderId));
  const identities = Object.entries(people).filter(([id, p]) => present.has(id) || [...p.names, ...p.aliases].some(n => n && text.includes(n)));
  const actor = ctx.triggerEntries.at(-1);
  const style = styleMode(ctx.chatKey);
  s.groupCandidates = groupStickerPool.candidates(ctx.chatKey, text, style?.profileId ? (style.stickerWeights || []) : null).map((item, i) => ({ ...item, choiceId: `g${i + 1}` }));
  const direct = ctx.triggerEntries.filter(e => e.atMe === true
    || (ctx.selfId && String(e.reply?.senderId) === String(ctx.selfId)));
  return '\n【菲比本地实验规则】\n'
    + `你的真实QQ=${ctx.selfId}；QQ账号实际昵称=${ctx.accountNickname}；账号角色名=${getConfig().persona.botName}。${style?.profileId ? `当前使用「${style.name}」风格；按当前角色设定措辞，不沿用菲比口癖或管理员称呼，不冒充样本真人。` : '这些身份均属于你。'}协议atMe=true表示明确@你，优先于显示昵称，不得重新猜成@别人。`
    + '\n【本批明确找你的消息，来自QQ协议判定】' + JSON.stringify(direct.map(e => ({messageId:e.mid,senderId:e.senderId,text:e.text})))
    + (phoebeReplyRequired(ctx) ? '\n本批需要回应，先send_message再finish；只有@没有正文时也简短应答，不可静默结束。' : '\n本批已进入无@接话机会：即使没有叫菲比，也可以主动接梗、聊天、表达好奇。优先寻找能自然接上的话；只有确实无话可接时才保持安静。')
    + '把未读批次作为多人正在进行的话题，优先回应最新且尚未回答的问题；已读内容只用于理解，不能逐条补答。不要重复上一轮结论。'
    + '被@或引用菲比、管理员私聊应正常回应。近期续聊只用于本批仍在讨论菲比的消息；群友之间继续原话题、出现“你”或你上一轮自称菲比，都不能单独证明仍在和你说话。若本批同时有讨论菲比和群友互聊，围绕讨论菲比的消息接话，不把旁人的问题认领给自己。普通闲聊只在系统按概率和冷却放行时参与。按语境平等回应所有群友，不把接话机会只留给管理员。明确对别人说的私事、已有回答且没有新内容、确实不了解的话题可以finish安静结束。多人可以一起讨论菲比，不因换人而重置话题。'
    + '回复默认10到50字，一两句话。send_message一次传完，系统先发送文字，再按配置概率单独发送一张QQ表情；未命中时只有文字，不要补发。群友收藏中有符合本次回复情绪和语境的图时用groupStickerId；否则用stickerId选菲比表情。不要两个字段一起传，也不要再单独调用发表情。'
    + `本群已收藏${groupStickerPool.list(ctx.chatKey).length}张群友表情。${style?.profileId ? '本轮收藏候选仅来自当前人格绑定的个人表情。' : ''}收藏候选已通过识图得到标签；结合你准备发送的话和聊天上下文选择，安慰时不要用嘲讽图，真实不安时不要只因词语重合就发吓人的图。带死亡、辱骂或恐吓文案的图只用于明确的玩笑情境，认真安慰时选温和图。候选不合适时选菲比表情，不使用未标注的收藏图随机配图。解释群友刚发的图仍须调用看图工具，不能拿收藏标签冒充那条消息的内容。`
    + '\n【可选群友收藏 id/情绪/画面/适用语境】' + JSON.stringify(s.groupCandidates.map(i => [i.choiceId, i.label.emotions, i.label.description, i.label.useWhen]))
    + '不要把检索过程、工具参数、内心思考发到群里。只有明确索要链接/来源才输出检索结果中的实际网址；普通梗解释用简短角色语言，不贴检索清单。检索失败须明确说没查到，不能冒充已查证。不要把玩笑中的食品词自动检索成陌生人物。'
    + '仿真实生活是当前人格的角色日常，生活工具记录的是虚构情节，不代表已在现实中执行行动；不要声称具备线下行动或未获授权的能力。'
    + '记忆用于培养互动风格：稳定偏好、说话方式、反复玩的梗、和菲比的共同经历。用memory_append提供本群原始消息#id作为证据；不可把玩笑/转述记成现实事实，不凭昵称合并QQ身份。新发现的名字/别称也按实际QQ记录。工具失败时不能声称已记住或已修改。'
    + `当前最新发言者真实QQ=${actor?.senderId}；管理权限=${isAdmin(actor?.senderId) ? '管理员，可在明确请求时使用phoebe_admin' : '普通成员，不能修改设置或删除记忆'}。管理员的角色称呼不改变权限。`
    + '\n【成员名与别称，按群+QQ区分】' + JSON.stringify(identities)
    + '\n【可选菲比表情 id/标题/标签】' + JSON.stringify(ids.map(id => { const m = memes().find(x => x.id === id); return [id,m.title,m.tags,m.category]; }));
}

export function phoebeToolAllowed(id, ctx) {
  if (!enabled()) return true;
  const allowed = new Set(['send_message','finish','get_recent_messages','get_active_members','memory_query','memory_append','web_search','web_fetch','phoebe_admin',
    'get_message_images','image-ref-hint__read_image','image-ref-hint__list_viewable_images',
    'life-memory__life_note','life-memory__life_recall','life-memory__life_done','life-memory__life_plan']);
  return allowed.has(id) && (id !== 'phoebe_admin' || isAdmin(ctx.triggerEntries.at(-1)?.senderId));
}

export function phoebeToolResult(ctx, name, result) {
  if (!enabled() || !['web_search','web_fetch'].includes(name) || result.isError) return;
  const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  for (const u of content.match(/https?:\/\/[^\s"<>\\]+/g) || []) chatState(ctx.chatKey).sources.add(u.replace(/[，。；）)]+$/, ''));
}

export async function sendPhoebeReply(onebot, chatKey, text, options) {
  const s = chatState(chatKey);
  const urls = text.match(/https?:\/\/[^\s<>]+/g) || [];
  if (!s.linksRequested) text = text.replace(/https?:\/\/[^\s<>]+/g, '').trim();
  else for (const url of urls) if (!s.sources.has(url.replace(/[，。；）)]+$/, ''))) throw new Error('回复链接没有实际检索来源，拒绝发送');
  if (options.groupStickerId && options.stickerId != null) throw new Error('收藏表情和菲比表情只能选择一张');
  const collected = options.groupStickerId ? s.groupCandidates?.find(i => i.choiceId === options.groupStickerId) : null;
  if (options.groupStickerId && !collected) throw new Error('所选收藏表情不在本轮已标注候选中');
  const probability = getConfig().phoebe.sticker_probability;
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('表情概率须为0到1之间的数值');
  const withSticker = Math.random() < probability;
  let meme;
  let sticker;
  if (withSticker) {
    let local;
    if (collected) {
      local = collected.path;
    } else {
      let candidates = memes().filter(m => (s.candidates.length ? s.candidates.includes(m.id) : true) && !s.recent.includes(m.id));
      if (options.stickerId !== undefined && options.stickerId !== null) {
        meme = candidates.find(m => m.id === Number(options.stickerId));
        if (!meme) throw new Error('所选表情没有出现在本轮候选列表中');
      } else {
        if (/菲八|生气|愤怒/.test(text)) candidates = candidates.filter(m => ANGER.has(m.id));
        meme = candidates[Math.floor(Math.random() * candidates.length)];
      }
      if (!meme) throw new Error('本轮没有可发送的菲比表情');
      const ext = path.extname(meme.url);
      local = path.join(getConfig().phoebe.imageCache, `${meme.id}${ext}`);
      if (!fs.existsSync(local)) {
        const url = 'https://kato-shoko705.github.io/Phoebe-Hub/' + meme.url.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!res.ok) throw new Error(`下载菲比表情${meme.id}失败 HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length || buf.length > 10 * 1024 * 1024) throw new Error('表情大小不符合已有10MB发送限制');
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, buf);
      }
    }
    sticker = {type:'image',data:{file:'base64://' + fs.readFileSync(local).toString('base64'),sub_type:1,summary:'[动画表情]'}};
  }
  const [kind,id] = chatKey.split(':');
  const message = [];
  if (options.replyToMessageId != null) message.push({ type:'reply', data:{id:String(options.replyToMessageId)} });
  if (options.atUserId != null && kind === 'group') message.push({ type:'at',data:{qq:String(options.atUserId)} });
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const target = { [kind === 'group' ? 'group_id' : 'user_id']:id };
  message.push({type:'text',data:{text}});
  const data = await onebot.call(action, { ...target, message });
  s.lastReply = Date.now();
  if (!withSticker) return { ...data, stickerSkipped:true };
  let stickerData;
  try {
    // QQ receives a standalone sticker, with no text/reply/@ segments mixed in.
    stickerData = await onebot.call(action, { ...target, message:[sticker] });
  } catch (error) {
    // Preserve the confirmed text receipt so the sender does not replay it.
    return { ...data, stickerError:`文字已发送（${data.message_id}），表情发送未确认：${error.message}` };
  }
  if (collected) groupStickerPool.markUsed(chatKey, collected);
  else s.recent = [...s.recent,meme.id].slice(-4);
  return { ...data, stickerMessageId:stickerData.message_id, phoebeMeme:meme?.id, groupSticker:collected?.id };
}

export function registerPhoebeTools() {
  if (!enabled()) return;
  registerTool({
    id:'memory_append', name:'记录有来源的群友印象', category:'memory',
    description:'记录稳定印象/偏好/称呼/共同梗。必须给出当前群聊天记录中的本地id证据。印象至少两条本人发言；别称需明确自称或@/引用确认，alias的content只填具体别称。不要把玩笑当现实。',
    parameters:{type:'object',properties:{userId:{type:'string'},target:{type:'string'},kind:{type:'string',enum:['impression','preference','event','slang','alias']},content:{type:'string'},sourceIds:{description:'消息前#后面的真实QQ消息id，可为负数；不是本地序号',type:'array',items:{type:['integer','string']}}},required:['userId','kind','content','sourceIds']},
    async execute(ctx,args) {
      if (!Array.isArray(args.sourceIds)) throw new Error('sourceIds必须是消息#id数组');
      const sourceIds = args.sourceIds.map(String);
      const rows = ctx.store.recent(ctx.chatKey,{limit:100}).filter(m => m.mid != null && sourceIds.includes(String(m.mid)));
      if (!['impression','preference','event','slang','alias'].includes(args.kind) || !Array.isArray(args.sourceIds) || !/^\d+$/.test(args.userId) || !args.content?.trim() || args.content.length > 120 || !rows.length || rows.length !== new Set(sourceIds).size) throw new Error('记忆需要准确QQ号、120字以内内容和本群可查证#消息id');
      if (rows.some(e => e.self)) throw new Error('菲比自己的回答不能作为群友特征证据');
      if (args.kind === 'impression' && rows.filter(e => e.senderId === args.userId).length < 2) throw new Error('稳定印象需要至少两条该QQ本人发言');
      if (args.kind !== 'alias' && rows.some(e => e.senderId !== args.userId)) throw new Error('群友事实只记录本人发言，转述不能冒充自述');
      if (args.kind === 'alias' && !rows.some(e => e.senderId === args.userId || e.text.includes(`QQ:${args.userId}`))) throw new Error('别称需要本人或准确@/引用证据');
      const entry = ctx.memory.append(ctx.chatKey,'memberImpression',`[${args.kind}] ${args.content}`,{userId:args.userId,target:args.target || args.userId});
      const file = jsonFile('phoebe-memory-evidence.jsonl');
      fs.appendFileSync(file,JSON.stringify({chatKey:ctx.chatKey,userId:args.userId,kind:args.kind,content:entry.content,sources:rows,createdAt:Date.now()})+'\n',{mode:0o600});
      if (args.kind === 'alias') {
        const person = (loadNames()[ctx.chatKey] ||= {})[args.userId] ||= {names:[],aliases:[]};
        if (!person.aliases.includes(args.content)) person.aliases.push(args.content);
        writeJson(jsonFile('phoebe-names.json'),names);
      }
      return {content:JSON.stringify({saved:true,entry})};
    }
  });
  registerTool({
    id:'phoebe_admin',name:'菲比管理员设置',category:'system',
    description:'仅真实管理员明确要求时：查看设置、调整本群接话概率/冷却/解析开关、纠正或删除本群指定QQ的一条记忆。不能执行系统命令。',
    parameters:{type:'object',properties:{action:{enum:['status','setting','forget','remember'],type:'string'},name:{enum:['random_probability','keyword_probability','recent_keyword_probability','cooldown_seconds','parser_enabled'],type:'string'},value:{type:'number',description:'概率使用0到1的小数，例如60%=0.6；cooldown_seconds按秒；parser_enabled用0或1'},userId:{type:'string'},content:{type:'string'}},required:['action']},
    async execute(ctx,args) {
      const actor = ctx.triggerEntries.at(-1);
      if (!isAdmin(actor?.senderId)) throw new Error('真实QQ没有管理员权限');
      if (args.action !== 'status' && !/设置|调整|改成|改为|修改|记住|记下|删除|忘掉|忘记|纠正|开启|关闭|关掉/.test(actor.text)) throw new Error('管理操作需要管理员当前明确请求');
      if (args.action === 'status') return {content:JSON.stringify({model:getConfig().api.model,settings:settings(ctx.chatKey),groups:getConfig().allow.groups})};
      if (args.action === 'setting') {
        if (!ctx.chatKey.startsWith('group:')) throw new Error('请在要设置的测试群下达命令');
        if (!Number.isFinite(args.value)) throw new Error('设置值须是数字');
        const ok = args.name === 'cooldown_seconds' ? args.value >= 0 && args.value <= 3600 : args.name === 'parser_enabled' ? [0,1].includes(args.value) : ['random_probability','keyword_probability','recent_keyword_probability'].includes(args.name) && args.value >= 0 && args.value <= 1;
        if (!ok) throw new Error('设置名称或值不合法');
        updateConfig({phoebe:{groups:{[ctx.chatId]:{[args.name]:args.value}}}});
        writeJson(getConfig().phoebe.parserSettings,Object.fromEntries(Object.entries(getConfig().phoebe.groups).map(([g,v]) => [g,Boolean(v.parser_enabled)])));
        return {content:JSON.stringify({updated:true,name:args.name,value:args.value})};
      }
      if (!/^\d+$/.test(args.userId) || !args.content?.trim()) throw new Error('管理记忆须指定真实QQ和具体内容');
      if (args.action === 'forget') return {content:JSON.stringify({removed:ctx.memory.remove(ctx.chatKey,'memberImpression',{userId:args.userId,content:args.content})})};
      if (args.content.length > 120) throw new Error('记忆最多120字');
      const entry = ctx.memory.append(ctx.chatKey,'memberImpression',args.content,{userId:args.userId,target:args.userId});
      fs.appendFileSync(jsonFile('phoebe-memory-evidence.jsonl'),JSON.stringify({chatKey:ctx.chatKey,userId:args.userId,entry,admin:actor.senderId,source:actor,createdAt:Date.now()})+'\n',{mode:0o600});
      return {content:JSON.stringify({saved:true,entry})};
    }
  });
}
