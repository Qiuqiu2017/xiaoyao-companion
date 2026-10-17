package com.qiuqiu.xiaoyao;

import meteordevelopment.meteorclient.addons.MeteorAddon;
import meteordevelopment.meteorclient.systems.modules.Modules;

public class XiaoyaoAddon extends MeteorAddon {
    @Override
    public void onInitialize() {
        Modules.get().add(new XiaoyaoAI());
    }

    @Override
    public String getPackage() {
        return "com.qiuqiu.xiaoyao";
    }

    @Override
    public String getWebsite() {
        return "https://qiuqiu2017.github.io/xiaoyao/";
    }
}
