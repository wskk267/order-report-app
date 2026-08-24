# Android APK 构建

## 方案结构

这个项目不是 Flutter 项目，而是一个原生 Android WebView 壳，前端业务页面和离线存储运行在 WebView 中。整个项目可以在没有图形界面的 Linux 服务器上完成构建，不需要 Android Studio。

- `android/app/src/main/java/com/orderreport/app/MainActivity.java`：Android 入口，加载内置页面。
- `android/app/src/main/AndroidManifest.xml`：网络权限、应用入口和 HTTPS 安全配置。
- `public/index.html`、`public/app.js`、`public/styles.css`：业务界面。
- `shared/domain.js`：报单、FIFO、退款比例、统计和同步操作的核心规则。
- `scripts/sync-android-assets.js`：把 `public/` 和 `shared/domain.js` 复制到 APK 的 `assets/`。
- `android/app/src/main/assets/`：APK 实际打包的静态资源，不要只修改这里；修改前端后重新执行资源同步。

## 准备环境

安装以下工具：

- Android SDK Command-line Tools。
- Android SDK Platform 35、Platform-Tools 和 Build Tools 35.0.0。
- JDK 17。
- Gradle Wrapper（项目已包含，版本为 8.7）。
- Node.js 18.17 或更高版本。

确认 Java 和 Node 环境：

```bash
java -version
node --version
```

如果系统还没有 JDK 17：

```bash
sudo apt-get update
sudo apt-get install -y openjdk-17-jdk unzip
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64
export PATH="$JAVA_HOME/bin:$PATH"
java -version
```

## 安装命令行 Android SDK

下面把 SDK 安装到 `/mnt/nvme/android-sdk`，不需要 root 权限：

```bash
SDK_ROOT=/mnt/nvme/android-sdk
mkdir -p "$SDK_ROOT/cmdline-tools" /tmp/android-cmdline-tools
curl -fL https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
  -o /tmp/android-commandlinetools.zip
unzip -q /tmp/android-commandlinetools.zip -d /tmp/android-cmdline-tools
rm -rf "$SDK_ROOT/cmdline-tools/latest"
mv /tmp/android-cmdline-tools/cmdline-tools "$SDK_ROOT/cmdline-tools/latest"

SDKMANAGER="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMANAGER" --sdk_root="$SDK_ROOT" --licenses
"$SDKMANAGER" --sdk_root="$SDK_ROOT" \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0"
```

设置当前终端的 SDK 路径：

```bash
export ANDROID_SDK_ROOT=/mnt/nvme/android-sdk
export PATH="$ANDROID_SDK_ROOT/platform-tools:$ANDROID_SDK_ROOT/cmdline-tools/latest/bin:$PATH"
```

确认：

```bash
adb version
sdkmanager --list | head -n 30
```

## 可选：安装独立 Gradle 8.7

Ubuntu 自带的 Gradle 可能版本太旧，直接下载到 `/mnt/nvme/gradle`：

```bash
GRADLE_ROOT=/mnt/nvme/gradle
mkdir -p "$GRADLE_ROOT"
curl -fL https://services.gradle.org/distributions/gradle-8.7-bin.zip \
  -o /tmp/gradle-8.7-bin.zip
unzip -q /tmp/gradle-8.7-bin.zip -d "$GRADLE_ROOT"
export PATH="$GRADLE_ROOT/gradle-8.7/bin:$PATH"
gradle --version
```

## 配置项目 SDK 路径

`local.properties` 已被 Git 忽略，可以直接生成：

```bash
printf 'sdk.dir=/mnt/nvme/android-sdk\n' \
  > /mnt/nvme/item/order-report-app/android/local.properties
```

## 生成 Debug APK

在项目根目录执行：

```bash
npm install
npm run android:assets
cd android
./gradlew --no-daemon assembleDebug
```

生成文件：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装到 USB 调试设备：

```bash
adb devices
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## 生成 Release APK

正式发布需要自己的签名文件。签名文件不能提交到公开仓库：

```bash
keytool -genkeypair -v \
  -keystore order-report-release.jks \
  -alias order-report \
  -keyalg RSA -keysize 2048 -validity 10000
```

在 `android/keystore.properties` 写入本机签名配置，该文件已被 `.gitignore` 排除：

```properties
storeFile=../order-report-release.jks
storePassword=替换为密钥库密码
keyAlias=order-report
keyPassword=替换为密钥密码
```

然后执行：

```bash
cd android
./gradlew --no-daemon assembleRelease
```

不要把 `.jks`、密码、`keystore.properties` 或已签名 APK 上传到公开 GitHub 仓库。

## 修改代码后的流程

涉及界面或业务规则时执行：

```bash
npm test
npm run android:assets
cd android
./gradlew --no-daemon assembleDebug
```

退款比例逻辑在 `shared/domain.js` 的 `addRefund` 和 `updateRefund` 中；Android 页面中的只读金额展示在 `public/app.js` 的 `refundEditor` 和 `updateRefundAmount` 中。资源同步脚本会把最新代码复制到 `android/app/src/main/assets/`，否则 APK 可能仍然包含旧页面。

## 服务器地址和同步令牌

APK 内置的是离线页面，不把真实服务器地址和令牌编译进公开源码。首次启动后，在 APP 的“设置”页面填写 HTTPS API 地址和本机 `runtime/sync-token` 内容。服务端默认监听 `127.0.0.1:3011`，可通过 Caddy/frpc 对外提供 HTTPS 地址。
