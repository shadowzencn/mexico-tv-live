# AGENTS.md：墨西哥电视直播 需求与开发约定

本文件面向在本仓库中工作的 AI 编码代理和新加入的开发者。它描述项目目标、功能需求、技术约束和协作规则。修改代码前请先阅读。

## 1. 项目概述

一个纯前端的网页，用于在浏览器中观看墨西哥主流电视频道的直播，并为每个频道提供中文简介。

- 目标用户：中文用户，想在国内网络环境下观看墨西哥电视直播。
- 运行方式：`python serve.py`（或 Windows 上 `py serve.py`），然后打开 http://127.0.0.1:8000/。
- 不做构建。没有 npm、打包器或框架，所有依赖都放在 `vendor/` 中。

## 2. 目录结构

```
index.html              页面结构与播放器标记
assets/css/app.css      全部样式（含手机端适配）
assets/js/app.js        页面逻辑：信号检测、播放、切换、收藏、统计等
assets/js/channels.js   频道数据（名称、中文简介、信号源、分类、关键词）
assets/img/favicon.svg  网站图标
serve.py                本地静态服务器 + YouTube 直播解析接口
vendor/videojs/         Video.js 10.2.0（含 HLS 的 hls.js 媒体模块），本地副本
docs/                   README 截图、设计文档
README.md               面向使用者的说明
AGENTS.md               本文件
```

## 3. 功能需求

### 3.1 频道与分类
- 共 17 个频道，数据全部在 `assets/js/channels.js`。
- 分类：全部、综合娱乐、新闻资讯、公共文化、我的收藏。
- 支持搜索（忽略大小写和重音，匹配频道名、中文名、电视台、分类、关键词）。
- 收藏保存在 `localStorage`（键 `mxtv:favorites`）。

### 3.2 信号源
- 每个频道有一个或多个信号源，类型为 `hls`、`youtube` 或无（仅外链）。
- 信号源按优先级选择：可直连的 HLS > 检测中的 HLS > YouTube > 其他。
- HLS 信号先做可达性探测（`probe`）：403 或 451 标记为地区限制，其他失败标记为暂不可用。
- YouTube 信号先检测当前网络能否访问 YouTube（用 favicon 图片请求，无需 CORS）。
- 无可嵌入信号的频道显示“官方平台”，给出官网入口。

### 3.3 播放器（Video.js 10）
- 播放器结构：`<media-i18n lang="zh-CN">` > `<video-player>` > `<video-skin>` > `<hlsjs-video>`。
- 画质：通过 `player.store.videoRenditionList` 列出档位，`selectVideoRendition(id | 'auto')` 切换。
- 自动播放：加载首帧后调用 `play()`；被浏览器拦截时静音再播，并显示“点击开启声音”按钮。
- 快捷键：空格播放/暂停、M 静音、F 全屏、I 画中画、`[` `]` 切换频道、T 剧场模式、`/` 搜索。
- 播放失败：HLS 致命错误或加载超时 20 秒后自动切换到下一个可用信号源。若分片仍在到达则延长一轮。
- 地区限制、暂不可用、YouTube 不可达、频道未在直播 时，分别显示对应的覆盖层和操作按钮。

### 3.4 右键菜单与统计面板
- HLS 直连时，右键播放器弹出菜单：复制播放地址、统计信息。
- 统计信息每秒刷新，包括频道、信号源、播放地址、状态、分辨率、当前画质、带宽估计、缓冲余量、已加载分片、丢帧、音量。
- 复制播放地址：优先使用 `navigator.clipboard`，不可用时退回 `execCommand('copy')`。

### 3.5 页面交互
- 哈希路由：`#/频道 id`，刷新后保持当前频道；无哈希时恢复上次频道，否则默认 Imagen Televisión。
- 剧场模式：状态保存在 `localStorage`（键 `mxtv:theater`）。
- 顶部双时钟：墨西哥城时间与北京时间。
- 手机端：播放器在 720px 以下吸顶，列表在下方。
- 频道信号重新检测按钮，检测完成后用 toast 提示结果。

### 3.6 YouTube 接口（`serve.py`）
- `GET /api/youtube-live?channel=UC...` 返回 `{ "live": bool, "videoId": string }`，缓存 5 分钟。
- 频道 ID 格式错误返回 400；上游失败返回 502。
- 没有此接口时（静态托管），页面退回到按频道嵌入 `embed/live_stream?channel=`。

## 4. 非功能需求

- 界面语言：中文。频道简介、提示文字、播放器控件标签都使用中文。
- 设计风格：深色、现代，参考主流流媒体产品。
- 不存储、不转码、不转发任何音视频内容。页面文案须保留版权声明。
- 不依赖 CDN：播放器和 hls.js 都在 `vendor/` 中，首次加载只请求本站资源和 YouTube 嵌入。
- 兼容：现代 Chrome、Edge、Firefox、Safari；桌面和手机宽度。
- 不引入构建步骤。新依赖需要说明理由，并把许可证文件放入 `vendor/<库名>/`。

## 5. 技术约束

- 原生 ES Module，不使用框架。
- 播放器使用 Video.js 10 的 HTML 预设（`video` 预设，而非 `live-video`）。原因：`live-video` 不提供画质选择，而画质选择是需求的一部分。
- Video.js 与 Vidstack 不能同时加载（自定义元素名冲突）。
- 修改 `vendor/videojs/` 时，整个目录必须成套替换，不能只替换单个文件（共享 chunk）。
- `vendor/videojs/` 只保留了 `video.js`、`media/hlsjs-video.js`、`locales/zh-CN.js`、`ui/` 和共享 chunk。升级版本时，从 `@videojs/cdn` 包重新拷贝这些文件，并同步更新 `README.md` 中的版本号。
- 不要在 `index.html` 中同时引入 `vendor/videojs` 之外的播放器库。

## 6. 开发约定

- 代码注释、README 和 UI 文案使用中文。变量名和函数名使用英文。
- 保持现有代码风格：2 空格缩进、单引号、分号、行宽约 140。
- 修改频道数据时，`id` 必须唯一，并与 `#/id` 路由一致。`category` 必须是 `CATEGORIES` 中已有的 id。
- 不要删除或改写用户的未提交改动。
- 不要把 `serve.py` 的 YouTube 接口改成需要登录或第三方密钥的实现。

## 7. 测试方法

本项目没有自动化测试。改动后至少要做以下人工检查（可用无头浏览器）：

1. `python serve.py` 能启动，首页无控制台报错。
2. 默认频道 Imagen Televisión 能开始播放（或在网络不通时显示正确的覆盖层）。
3. 切换一个 HLS 频道、一个地区限制频道（Las Estrellas）、一个 YouTube 频道（Multimedios）。
4. 画质菜单可以切换并返回自动。
5. 右键菜单和统计面板能打开、数据在刷新。
6. 空格、M、F、`[`、`]`、T 快捷键生效。
7. 收藏、搜索、剧场模式、哈希路由刷新后保持。
8. 手机宽度（390px）下播放器吸顶，布局不重叠。

## 8. 已知限制

- YouTube 嵌入需要用户网络能访问 YouTube。
- 多数墨西哥官方信号有地区限制，境外访问通常不可用。
- 部分频道（如 Canal Congreso）常处于离线状态，属于信号源问题，不是代码问题。
- 右键“复制播放地址”在无剪贴板权限的环境中可能失败，此时会提示手动复制。

## 9. 交付

- 修改后更新 `README.md`（如涉及运行方式、频道或依赖版本）。
- 打包 zip 时，压缩整个项目目录，保留顶层目录名 `mexico-tv-live/`。
- 不要提交 `__pycache__`。
