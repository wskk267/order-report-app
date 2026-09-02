# 报单管家

单人使用的 Android 报单、库存、快递和返款记录工具。APP 在无法连接服务器时仍然可以录入和查询，恢复网络后会自动同步。

## 功能

- 报单：时间、原消息、多个商品行、数量、商品备注、实际付款、预计返款、预计返利。
- 快递：单号、快递价格、多个商品行；保存时按报单时间先进先出扣除库存，并自动计算商品实际价格和预计返款/返利。
- 打印单子：从快递记录生成“快递单号 + 商品 * 数量 + 商品备注”的打印内容，可复制或调用系统打印。
- 查询和修改：报单、快递、实际返款和退款记录均可查询、编辑或作废。
- 返款：一笔快递可以分多次登记实际返款。
- 退款：只能从剩余可用库存选择商品批次，退款数量退出仓库；退款金额按商品实际付款和退款数量比例自动生成，并从付款和预期收益统计中扣除。
- 同步：设置页分别提供保存连接、测试连接、上传本地操作和下载服务器数据。
- 备份：本机和服务器数据均可预览、复制或保存为 JSON；Android APK 使用系统文件选择器保存。
- 统计：累计商品付款、累计快递费用、预计未返款、已返款、利润、纯利润和利率。

统计公式（商品预计值与已结单实际值分开计算，仓库中的未发货商品也包含预计值）：

```text
预计返款 = 所有未退款商品的原始预计返款
预计返利 = 所有未退款商品的预计返利
未结单预计返款 = 仓库商品预计返款 + 未结单快递商品预计返款
已结单实际返款 = 已结单快递的实际返款记录合计
预计未返款 = max(未结单预计返款 - 未结单已返款, 0)
利润 = 已结单实际返款 + 未结单预计返款 - 累计商品付款 + 预计返利
纯利润 = 利润 - 快递费用
利率 = 纯利润 / 累计商品付款
```

“预计返款”保留原始预测值，用来和快递结单时的实际返款比较；结单后不再用原始预测值代替实际值。未结单快递即使已经收到部分返款，也仍按预计值计入利润，直到结单确认最终金额。累计商品付款包含所有未退款商品的实际付款，未发货商品的成本会计入统计，但总览会在“预计未返款”下方单独显示待发货商品金额。退款商品会从累计商品付款、预计返款和预计返利中排除。金额以分保存，界面按人民币两位小数输入和显示。

客户端会保存服务器实例编号和最后版本。普通上传前先核对实例及版本，避免地址误切换或服务器备份回退时静默覆盖本机数据；下载覆盖始终需要确认，本机失败操作可逐条重试或丢弃。只更换同步令牌不会解除服务器绑定，仍会在上传前校验实例身份。

快递可以“结单”标记返款已完成；结单前需要登记一笔实际返款，金额可以是 `0.00`，结单时会显示实际返款与预计返款的差额。结单后不能继续编辑快递或返款，撤销结单后恢复编辑。已出库或已退款商品的名称、数量、付款和预计金额也不能回改，以免破坏历史统计；备注仍可修改。

服务端启动时会创建当天的 SQLite 备份，并每 24 小时检查一次，文件保存在 `runtime/backups/`。每次数据库成功写入后，当天的有效备份都会以原子替换方式滚动到最新版本，因此正常情况下每天只保留一份，而不再停留在当天最早的状态。替换前会检查已有备份的 SQLite 完整性和应用状态表；如果原备份已损坏，系统会保留原文件用于排查，并原子创建、随后复用一个带 `.recovered-*` 后缀的有效替代备份。

为兼容旧版本，读取数据库或本地缓存时只会归一化已知的旧派生字段，例如把挂在已作废快递下的历史出库/返款标记为作废、重算自动生成的退款金额；历史流水行仍会保留。未知结构、非法关联或不安全数值不会被猜测修复：浏览器端会进入恢复模式并保留原始缓存，服务端会拒绝启动或写入且不改原数据库。

退款金额公式：

```text
退款金额 = 商品实际付款总额 × 退款数量 / 商品报单数量
```

同一商品分多次退款时，系统会按累计比例分配到分，最后一笔自动补齐舍入余数，保证退款合计等于按比例计算的商品付款金额。

## 本地运行

```bash
npm install
cp .env.example .env
npm start
```

默认监听 `127.0.0.1:3011`。第一次启动会在 `runtime/sync-token` 生成权限为 `0600` 的同步令牌。把令牌填入 APP 的“设置”页面；令牌和 SQLite 数据库都不会被 Git 跟踪。

`ORDER_REPORT_RUNTIME_DIR` 可以整体调整运行目录；未单独设置 `ORDER_REPORT_DB_PATH` 或 `ORDER_REPORT_TOKEN_FILE` 时，数据库和令牌会一起放在该目录。生产环境优先使用源码仓库外的绝对路径；如果放在仓库内，必须先把实际目录加入 `.gitignore`。数据库旁的 `.lock` 目录是进程级排他锁，同一数据库只允许一个服务实例或恢复进程使用；崩溃留下的锁会在确认原进程已不存在后清理。

开发检查：

```bash
npm test
npm run android:assets
```

`deploy/order-report.service.example` 默认使用专用的非 root 用户并开启 systemd 防护选项。安装前先停止旧服务、创建用户，并把已有运行数据整体交给该用户；只修改目录本身的所有者会导致已有数据库和令牌仍不可读。路径变更时同步修改 unit 中的 `WorkingDirectory`、`ExecStart`、`EnvironmentFile` 和 `ReadWritePaths`：

```bash
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin order-report
sudo install -d -m 0700 -o order-report -g order-report /mnt/nvme/item/order-report-app/runtime
sudo chown -R order-report:order-report /mnt/nvme/item/order-report-app/runtime
sudo find /mnt/nvme/item/order-report-app/runtime -type d -exec chmod 0700 {} +
sudo find /mnt/nvme/item/order-report-app/runtime -type f -exec chmod 0600 {} +
sudo chown root:order-report /mnt/nvme/item/order-report-app/.env
sudo chmod 0640 /mnt/nvme/item/order-report-app/.env
sudo install -m 0644 deploy/order-report.service.example /etc/systemd/system/order-report.service
sudo systemctl daemon-reload
sudo systemctl enable --now order-report.service
```

## 对外访问

建议使用单独子域名，例如 `order.your-domain.example`，不要把真实域名直接写进公开仓库。把 `deploy/Caddyfile.snippet` 复制后替换为实际域名，再合并到现有 Caddy 配置，并让 frpc/反向代理只转发到本机 `3011`。

APP 设置里填写 HTTPS 地址，例如：

```text
https://order.your-domain.example
```

即使没有登录页面，API 仍然要求同步令牌。令牌只存在服务端权限文件和 APP 本机存储，仓库不包含真实地址、令牌、数据库或业务数据。

## Android 工程

Android 源码在 `android/`，前端资源由下面的脚本同步到 APK 资源目录：

```bash
npm run android:assets
cd android
./gradlew assembleDebug
```

Gradle 的 `preBuild` 也会自动执行资源同步，避免直接运行 `assembleDebug` 或 `assembleRelease` 时误打包旧页面。

APP 是无第三方运行库的 WebView 壳，数据由内置前端保存到 Android WebView 本地存储。项目包含 Gradle Wrapper，纯命令行环境不需要安装 Android Studio。

完整的环境准备、Debug/Release 构建和安装步骤见 [`docs/APK_BUILD.md`](docs/APK_BUILD.md)。

## 隐私和 Git

- 远端仓库是公开仓库，只提交通用源码和示例配置。
- `.env`、`runtime/`、数据库、同步令牌、APK 和 Android `local.properties` 已加入 `.gitignore`。
- Git 提交前不要把真实域名、令牌、导出 JSON 或日志放入仓库。
- `runtime/sync-token` 是访问业务数据的凭据，不要复制到聊天、截图或公开 issue。

## 恢复 SQLite 备份

恢复前必须先停止服务；即使遗漏这一步，数据库排他锁也会拒绝在线恢复。脚本只接受 `runtime/backups/` 下的普通文件并拒绝符号链接；恢复前会先复制到权限为 `0600` 的唯一临时文件，再验证 SQLite 完整性、报单管家状态结构及已有同步/审计表字段。替换前会以不覆盖的唯一文件名保留当前数据库：

```bash
sudo systemctl stop order-report.service
sudo -u order-report /usr/bin/node scripts/restore-sqlite-backup.js runtime/backups/order-report-YYYY-MM-DD.sqlite3
sudo systemctl start order-report.service
```

恢复前的数据库会保存为同目录下的 `order-report.sqlite3.before-restore-*` 文件。恢复进程必须与服务使用同一账号，避免恢复后的数据库变成服务账号不可读的文件。
