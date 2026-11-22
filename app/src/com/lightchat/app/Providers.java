package com.lightchat.app;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.UUID;

final class Providers {

    private static final String PREFS = "lc";
    private static final String KEY = "providers";

    private Providers() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static JSONArray load(Context ctx) {
        String raw = prefs(ctx).getString(KEY, null);
        if (raw == null) {
            JSONArray seed = defaults();
            prefs(ctx).edit().putString(KEY, seed.toString()).apply();
            return seed;
        }
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    static JSONObject find(Context ctx, String id) {
        JSONArray arr = load(ctx);
        for (int i = 0; i < arr.length(); i++) {
            JSONObject p = arr.optJSONObject(i);
            if (p != null && id.equals(p.optString("id"))) return p;
        }
        return null;
    }

    static String upsert(Context ctx, JSONObject p) {
        String id = p.optString("id");
        if (id.isEmpty()) {
            id = UUID.randomUUID().toString().replace("-", "").substring(0, 12);
            try {
                p.put("id", id);
            } catch (Exception ignored) {
            }
        }
        JSONArray arr = load(ctx);
        JSONArray out = new JSONArray();
        boolean replaced = false;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject cur = arr.optJSONObject(i);
            if (cur != null && id.equals(cur.optString("id"))) {
                out.put(p);
                replaced = true;
            } else if (cur != null) {
                out.put(cur);
            }
        }
        if (!replaced) out.put(p);
        prefs(ctx).edit().putString(KEY, out.toString()).apply();
        return id;
    }

    static void delete(Context ctx, String id) {
        JSONArray arr = load(ctx);
        JSONArray out = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject cur = arr.optJSONObject(i);
            if (cur != null && !id.equals(cur.optString("id"))) out.put(cur);
        }
        prefs(ctx).edit().putString(KEY, out.toString()).apply();
        SecureStore.remove(ctx, id);
    }

    private static JSONArray defaults() {
        JSONArray arr = new JSONArray();
        try {
            JSONObject ds = new JSONObject();
            ds.put("id", "deepseek");
            ds.put("name", "DeepSeek");
            ds.put("baseUrl", "https://api.deepseek.com");
            ds.put("protocol", "openai");
            ds.put("models", new JSONArray().put("deepseek-chat").put("deepseek-reasoner"));
            ds.put("extraHeaders", new JSONObject());
            arr.put(ds);

            JSONObject custom = new JSONObject();
            custom.put("id", "custom");
            custom.put("name", "自定义服务");
            custom.put("baseUrl", "");
            custom.put("protocol", "openai");
            custom.put("models", new JSONArray());
            custom.put("extraHeaders", new JSONObject());
            arr.put(custom);
        } catch (Exception ignored) {
        }
        return arr;
    }
}
