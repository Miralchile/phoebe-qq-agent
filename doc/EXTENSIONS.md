# 改动与来源

上游仓库：https://github.com/K0nd1us/QQ-agent

基线提交：`fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`。保留上游 MIT 许可。此快照以 Miralchile 的本地改动建立独立历史，不宣称框架、控制台或市场插件为本项目原创。

| 本地新增或适配 | 文件 |
| --- | --- |
| 人格提取、样本筛选、权限、显式切换 | `src/style-profiles.js` |
| 七维证据化角色提示词与校验 | `src/style-role-prompt.js` |
| 历史消息来源、按需拉取、覆盖范围 | `src/history-source.js`, `scripts/pull-group-history.mjs` |
| 角色上下文、概率接话、相关续聊、管理员工具 | `src/phoebe.js` |
| 群表情收藏、去重、人格关联与语境候选 | `src/group-stickers.js` |
| 一次性视觉情绪标注与处理记录 | `src/sticker-tags.js`, `scripts/tag-group-stickers.mjs` |
| 明确图片请求的分派、生成与发送 | `src/grok-images.js` |
| 启动后首次唤醒补看群历史 | `plugins/offline-study-local/` |

集成适配集中在 `src/app.js`、`src/config.js`、`src/orchestrator.js`、`src/prompt.js`、`src/sender.js`、`src/store.js`、`src/tools.js`、`src/routes.js`、`src/llm.js`、`src/onebot.js`、`src/plugin-loader.js`、`src/sticker-manager.js` 和 `src/web-search.js`。这些文件沿用上游实现，新增钩子和接口不能视作整份文件的原创声明。

原部署另装有适应群风格、认人、图片指代、仿真生活、问号接龙和复读插件。其中部分来自 QQ-agent 插件市场，独立分发许可尚未在本次整理中确认，因此源码没有复制进本仓库。复读插件的本地改动包含原文发送、排除命令和媒体、只消费匹配等待批次、保留忙碌与暂停状态以及限频；该适配说明不表示已在本快照启用复读。需要使用时应从原市场核对来源、许可和依赖后自行安装。

发布时删除了私人关系提示分支和固定账号常量；管理员改从 `phoebe.adminIds` 读取。未复制生产配置，未修改运行中的本地部署。原部署中的人物画像、QQ／群号、关系身份、人设实例、对话与表情资产不随源码分发。
