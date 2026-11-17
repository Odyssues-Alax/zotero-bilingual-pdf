# Zotero 双语 PDF 对照

在 Zotero 中将英文论文生成可选择、搜索和复制的中文 PDF，左右对照原文和译文，同步翻页和缩放。插件按原页和栏位重排译文，尽量保留图表、公式与参考文献的原位。正文、标题和图注参与翻译，参考文献保留原文。

## 安装

适用于 64 位 Windows 上的 Zotero 9.0 至 10.0.x，主要处理带有可选中文字的英文科研论文 PDF。当前安装包使用 Windows 的宋体、Times New Roman 及后备字体。

1. 从 [GitHub Releases](https://github.com/Odyssues-Alax/zotero-bilingual-pdf/releases/latest) 下载 `bilingual-pdf-1.2.14.xpi`。
2. 在 Zotero 打开 **工具 → 插件**，点击右上角齿轮，选择 **Install Add-on From File…** 并打开 XPI。
3. 在 **工具 → 双语 PDF 设置…** 填写自己的 DeepSeek API Key。使用默认混合模式时，点击 **安装／修复本机引擎**。首次安装会联网下载隔离的 Python 环境、依赖和版面模型。
4. 在条目列表中右键 PDF 附件，选择 **中英 PDF 对照…**，再点击 **生成中文 PDF**。生成后，译版会作为附件保存。可在 **问题列表** 批量修复可自动处理的问题，也可在 **检查段落** 查看或调整译文。

默认译文和本机引擎分别位于 Zotero 配置目录下的 `bilingual-pdf/translations` 和 `bilingual-pdf/engine-runtime`，可在设置中改译文输出目录。引擎设在配置目录下，迁移到其他电脑后可重新运行引擎安装。此前用过本地开发版的用户可保留原输出路径设置，按需重新安装引擎。

## 数据与费用

PDF 提取、排版和文件保存都在本机进行。生成译文时，选中的段落文本会发往配置的翻译 API，开启结构辅助时也可能发送用于判定段落结构的少量上下文。PDF 文件留在本机。选择记住凭据时使用 Zotero 的凭据存储。插件本身不收费，API 调用费用由所选服务商计费。

## 开发

在仓库根目录运行 `powershell -ExecutionPolicy Bypass -File work/build.ps1` 打包，产物写入 `outputs/`。运行脚本测试前执行 `npm ci --prefix work/build`。架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，第三方组件与许可证见 [THIRD_PARTY.md](work/addon/THIRD_PARTY.md)。
