package com.local.fixlan;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;

public class FixLanAuth implements ModInitializer {
    private static final String[] SETTERS = {"method_3864", "setUsesAuthentication", "e", "func_71229_d"};

    @Override
    public void onInitialize() {
        ServerLifecycleEvents.SERVER_STARTED.register(server -> apply(server));
        ServerLifecycleEvents.SERVER_STARTING.register(server -> apply(server));
        System.out.println("[fixlan] initialized");
    }

    private static void apply(Object server) {
        for (String name : SETTERS) {
            try {
                java.lang.reflect.Method m = server.getClass().getMethod(name, boolean.class);
                m.invoke(server, Boolean.FALSE);
                System.out.println("[fixlan] online-mode disabled via " + name);
                return;
            } catch (Throwable ignored) {
            }
        }
        try {
            java.lang.reflect.Field f = server.getClass().getSuperclass().getDeclaredField("field_4543");
            f.setAccessible(true);
            f.setBoolean(server, false);
            System.out.println("[fixlan] online-mode disabled via field field_4543");
            return;
        } catch (Throwable ignored) {
        }
        System.out.println("[fixlan] ERROR: could not disable online-mode");
    }
}
