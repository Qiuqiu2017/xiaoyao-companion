package com.qiuqiu.xiaoyao;

import com.google.gson.JsonObject;
import meteordevelopment.meteorclient.settings.BoolSetting;
import meteordevelopment.meteorclient.settings.EnumSetting;
import meteordevelopment.meteorclient.settings.Setting;
import meteordevelopment.meteorclient.settings.SettingGroup;
import meteordevelopment.meteorclient.settings.StringSetting;
import meteordevelopment.meteorclient.systems.modules.Categories;
import meteordevelopment.meteorclient.systems.modules.Module;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class XiaoyaoAI extends Module {
    public enum Provider { DeepSeek, OpenAI, OpenRouter, SiliconFlow, Custom }

    public enum Thinking { Off, Low, Medium, High, Max }

    private final SettingGroup sg = settings.getDefaultGroup();

    public final Setting<Provider> provider = sg.add(new EnumSetting.Builder<Provider>()
        .name("provider")
        .description("LLM 提供商（OpenAI 兼容接口）")
        .defaultValue(Provider.DeepSeek)
        .build());

    public final Setting<String> model = sg.add(new StringSetting.Builder()
        .name("model")
        .description("模型 ID")
        .defaultValue("deepseek-flash")
        .wide()
        .build());

    public final Setting<Thinking> thinking = sg.add(new EnumSetting.Builder<Thinking>()
        .name("thinking")
        .description("思考强度")
        .defaultValue(Thinking.Max)
        .build());

    public final Setting<String> apiKey = sg.add(new StringSetting.Builder()
        .name("api-key")
        .description("API Key（留空则读取环境变量或 opencode 配置）")
        .defaultValue("")
        .wide()
        .build());

    public final Setting<String> baseUrl = sg.add(new StringSetting.Builder()
        .name("base-url")
        .description("自定义 Base URL（provider 选 Custom 时使用）")
        .defaultValue("")
        .wide()
        .build());

    public final Setting<String> botPath = sg.add(new StringSetting.Builder()
        .name("bot-path")
        .description("xiaoyao-companion 目录（包含 bot.js）")
        .defaultValue("/root/项目/xiaoyao-companion")
        .wide()
        .build());

    public final Setting<String> logPath = sg.add(new StringSetting.Builder()
        .name("log-path")
        .description("Minecraft latest.log 路径（用于自动识别 LAN 端口）")
        .defaultValue("/root/.local/share/red.ghs.axolotl/profiles/1.21.11-Fabric 0.19.5/logs/latest.log")
        .wide()
        .build());

    public final Setting<String> username = sg.add(new StringSetting.Builder()
        .name("username")
        .description("机器人账号名（离线登录）")
        .defaultValue("xiaoyao")
        .build());

    public final Setting<Boolean> autoRestart = sg.add(new BoolSetting.Builder()
        .name("auto-restart")
        .description("机器人掉线后自动重连（由 bot.js 处理）")
        .defaultValue(true)
        .build());

    private Process process;

    public XiaoyaoAI() {
        super(Categories.Misc, "xiaoyao-ai", "AI 陪玩机器人 xiaoyao（DeepSeek/OpenAI 兼容）");
    }

    @Override
    public void onActivate() {
        startBot();
    }

    @Override
    public void onDeactivate() {
        stopBot();
    }

    private void startBot() {
        if (process != null && process.isAlive()) return;

        File dir = new File(botPath.get());
        File script = new File(dir, "bot.js");
        if (!script.isFile()) {
            System.out.println("[xiaoyao] bot.js not found: " + script.getAbsolutePath());
            return;
        }

        try {
            JsonObject o = new JsonObject();
            o.addProperty("provider", provider.get().name().toLowerCase());
            o.addProperty("model", model.get());
            o.addProperty("thinking", thinking.get().name().toLowerCase());
            o.addProperty("apiKey", apiKey.get());
            o.addProperty("baseUrl", baseUrl.get());
            o.addProperty("username", username.get());
            o.addProperty("logPath", logPath.get());
            o.addProperty("port", 0);

            File cfg = new File(dir, "config.runtime.json");
            Files.writeString(cfg.toPath(), o.toString(), StandardCharsets.UTF_8);

            ProcessBuilder pb = new ProcessBuilder("node", "bot.js");
            pb.directory(dir);
            pb.environment().put("XIAOYAO_CONFIG", cfg.getAbsolutePath());
            pb.redirectErrorStream(true);
            pb.redirectOutput(ProcessBuilder.Redirect.appendTo(new File(dir, "bot.log")));

            process = pb.start();
            System.out.println("[xiaoyao] started: " + provider.get() + " / " + model.get() + " / " + thinking.get());
        } catch (Exception e) {
            System.out.println("[xiaoyao] start failed: " + e.getMessage());
        }
    }

    private void stopBot() {
        if (process != null) {
            process.descendants().forEach(ProcessHandle::destroy);
            process.destroy();
            process = null;
            System.out.println("[xiaoyao] stopped");
        }
    }
}
