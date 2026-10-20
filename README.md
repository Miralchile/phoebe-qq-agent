# Phoebe QQ Agent

基于 [K0nd1us/QQ-agent](https://github.com/K0nd1us/QQ-agent) 的群聊人格与语境表情实验分支。本仓库保留 QQ-agent 的消息接入、会话编排、工具系统和控制台，在其上增加人格侧写、上下文触发和表情选择能力。上游基线为 `fdfd325e148d91845a0aeea3dfdff4cf92fc61a1`，原作者 Kondius 的 MIT 许可和署名保留在 [LICENSE](LICENSE)。

这是经过脱敏的源码快照。运行中的个人部署、聊天数据库和账号授权没有迁入本仓库；源码中的管理员固定值已改为配置项，私人关系分支已删除。仓库使用全新 Git 历史，避免携带运行目录或旧凭证。

## 本分支的改动

| 能力 | 实现与边界 |
| --- | --- |
| 人格侧写与切换 | 按指定群和成员提取样本，支持协议 @ 定位；天数、条数可分别指定，目标样本最多 2000 条。切换只在明确命令后发生。 |
| 证据化人设提示词 | 侧写卡引用原始消息，再生成七个维度的角色提示词；缺失证据的部分留空，生成失败不保存半成品或自动重试。 |
| 多人群聊上下文 | 使用 QQ-agent 的已读／未读批次，增加明确 @ 判定、相关续聊、概率接话与冷却控制。 |
| 表情收藏和情绪选择 | 收藏协议标记的群表情，按图片内容去重；一次性视觉标注情绪、内容和适用语境，后续选择复用标签。 |
| 人格绑定表情 | 提取样本中的表情使用频率，切换人格时使用该人格绑定的表情候选。 |
| QQ 表情发送 | 文字和自定义表情分开发送，表情携带 `sub_type: 1`；发送概率可配置。最终显示仍取决于 QQ 客户端。 |
| 图片生成接入 | 明确 @ 加 `/画图`、`/生图` 或支持的自然表达，转至现有 Grok 图片代理；上游错误明确返回，不自动重试。 |
| 离线补课 | 本地扩展首次唤醒时读取可取得的最近 100 条群消息，只作为背景，不补执行旧命令。 |

改动入口和来源说明见 [EXTENSIONS.md](doc/EXTENSIONS.md)。市场插件与上游框架分别归原作者所有，本仓库不将它们列为原创实现。

## 使用

需要 Node.js 22、npm 和可用的 OneBot v11 消息服务。情绪标注需要 ffmpeg；聊天需要自行配置有权限使用的 OpenAI 兼容接口。不要把凭证写入源码。

```sh
npm ci --ignore-scripts
mkdir -p data
cp examples/config.json data/config.json
npm run server
```

启动前编辑 `data/config.json`，填写模型接口、OneBot 接口和控制台令牌，并在 `allow.groups`／`allow.private` 中明确加入允许的会话。示例白名单为空，`allowAllWhenEmpty` 为 false。默认不启用本分支的人格和表情扩展，避免尚未准备资源就开始调用或发送。

启用扩展前，将 `phoebe.enabled` 改为 true，在 `phoebe.adminIds` 中填写管理员身份，并为每个允许群设置 `phoebe.groups`。下面的占位符需要替换为自己的值：

```json
{
  "allow": { "groups": ["YOUR_GROUP_ID"], "private": [] },
  "phoebe": {
    "enabled": true,
    "adminIds": ["YOUR_ADMIN_ID"],
    "groups": {
      "YOUR_GROUP_ID": {
        "random_probability": 0.6,
        "keyword_probability": 0.8,
        "recent_keyword_probability": 0.8,
        "cooldown_seconds": 120,
        "parser_enabled": 0
      }
    },
    "sticker_probability": 0.8
  }
}
```

启用前还需要准备 `data/phoebe-catalog.json`、`data/phoebe-names.json` 和 `phoebe.imageCache`。名字库可从空对象 `{}` 开始；表情目录结构见 `test/fixtures/phoebe-catalog.json`，测试图片只用于测试，请自行准备有使用权限的素材。示例不包含群友名单、实际表情或菲比素材包。

管理员可使用 `/人格 提取 @成员 名称=示例 天数=5`、`/人格 完善 示例`、`/人格 提示词 示例`、`/人格 使用 示例` 和 `/人格 恢复菲比`。历史是否完整取决于 OneBot 和 QQ 实际能提供的数据；没有下载到的消息不会被当成已读取。

图片生成当前连接 `http://hermes:8645/v1/images/generations`，要求另行部署对应代理并拥有上游使用权限。本仓库不包含代理、OAuth 凭证或订阅权益，也不保证某一订阅可免费用于该接口。图片生成仍受服务商内容审核约束。

国内社交平台解析由原部署中的 AstrBot 及其解析插件承担，未打包进本仓库。`parser_enabled` 和 `parserSettings` 保留的是该部署的联动接口，单独启动此仓库不会获得完整的平台解析能力。Dockerfile 仅提供 Node.js 与 ffmpeg 基础环境，源码和配置仍需自行挂载。

## 验证

```sh
npm run test:extensions
```

扩展测试使用合成身份、模拟模型返回和模拟 QQ 发送，不需要真实账号、聊天数据库或图片素材。完整上游测试命令为 `npm test`，与扩展测试独立。实际执行结果和未验证范围见 [VALIDATION.md](doc/VALIDATION.md)。

## 数据边界

`data/`、凭证、授权目录、聊天日志、记忆、人格样本、素材缓存和 `node_modules/` 均不入库。正式运行时应限制控制台访问，并仅在群成员知情、允许的范围内整理聊天与侧写。测试中的身份编号是固定合成值，不对应本地部署账号。
