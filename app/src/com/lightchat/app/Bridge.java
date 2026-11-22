package com.lightchat.app;

import android.content.Context;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class Bridge {

    private final MainActivity act;
    private final WebView web;
    private final Context ctx;

    Bridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
        this.ctx = act.getApplicationContext();
    }

    @JavascriptInterface
    public String getProviders() {
        return Providers.load(ctx).toString();
    }

    @JavascriptInterface
    public String saveProvider(String json) {
        try {
            JSONObject p = new JSONObject(json);
            return Providers.upsert(ctx, p);
        } catch (Exception e) {
            return "";
        }
    }

    @JavascriptInterface
    public void deleteProvider(String id) {
        Providers.delete(ctx, id);
    }

    @JavascriptInterface
    public boolean setKey(String id, String key) {
        return SecureStore.put(ctx, id, key == null ? "" : key.trim());
    }

    @JavascriptInterface
    public void clearKey(String id) {
        SecureStore.remove(ctx, id);
    }

    @JavascriptInterface
    public boolean hasKey(String id) {
        return SecureStore.has(ctx, id);
    }

    @JavascriptInterface
    public String getSettings() {
        String raw = ctx.getSharedPreferences("lc", Context.MODE_PRIVATE).getString("settings", null);
        if (raw != null) return raw;
        return "{\"theme\":\"auto\",\"fontSize\":15,\"systemPrompt\":\"\",\"temperature\":0.7,\"maxTokens\":0,\"stream\":true,\"lastProviderId\":\"deepseek\",\"lastModel\":\"deepseek-chat\"}";
    }

    @JavascriptInterface
    public void saveSettings(String json) {
        try {
            new JSONObject(json);
            ctx.getSharedPreferences("lc", Context.MODE_PRIVATE).edit().putString("settings", json).apply();
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void startChat(String requestJson) {
        ApiClient.chat(ctx, this, requestJson);
    }

    @JavascriptInterface
    public void cancelChat(String id) {
        ApiClient.cancel(id);
    }

    @JavascriptInterface
    public void testProvider(String configJson) {
        ApiClient.test(ctx, this, configJson);
    }

    @JavascriptInterface
    public void pickMedia() {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                act.pickMedia();
            }
        });
    }

    @JavascriptInterface
    public void deleteMedia(String id) {
        MediaFiles.delete(ctx, id);
    }

    @JavascriptInterface
    public String readClipboard() {
        final String[] out = new String[]{""};
        final CountDownLatch latch = new CountDownLatch(1);
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
                    if (cm != null && cm.hasPrimaryClip() && cm.getPrimaryClip() != null
                            && cm.getPrimaryClip().getItemCount() > 0) {
                        CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(act);
                        if (cs != null) out[0] = cs.toString().trim();
                    }
                } catch (Exception ignored) {
                } finally {
                    latch.countDown();
                }
            }
        });
        try {
            latch.await(1200, TimeUnit.MILLISECONDS);
        } catch (Exception ignored) {
        }
        return out[0];
    }

    @JavascriptInterface
    public void setTheme(final boolean dark) {
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                act.applyTheme(dark);
            }
        });
    }

    @JavascriptInterface
    public void setBackDepth(int depth) {
        act.setBackDepth(depth);
    }

    @JavascriptInterface
    public void openUrl(String url) {
        try {
            act.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public void toast(String msg) {
        try {
            Toast.makeText(act, msg, Toast.LENGTH_SHORT).show();
        } catch (Exception ignored) {
        }
    }

    @JavascriptInterface
    public String version() {
        return "1.1.0";
    }

    void emitEvent(String id, String type, String text, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("id", id);
            o.put("type", type);
            if (text != null) o.put("text", text);
            if (message != null) o.put("message", message);
            eval("window.__api&&window.__api.onEvent(" + JSONObject.quote(o.toString()) + ")");
        } catch (Exception ignored) {
        }
    }

    void emitTest(String json) {
        eval("window.__api&&window.__api.onTest(" + JSONObject.quote(json) + ")");
    }

    void handlePickedMedia(final Intent data) {
        if (data == null) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<Uri> uris = new ArrayList<Uri>();
                ClipData clip = data.getClipData();
                if (clip != null) {
                    for (int i = 0; i < clip.getItemCount(); i++) {
                        Uri u = clip.getItemAt(i).getUri();
                        if (u != null) uris.add(u);
                    }
                }
                if (uris.isEmpty() && data.getData() != null) uris.add(data.getData());
                JSONArray out = new JSONArray();
                int failed = 0;
                for (int i = 0; i < uris.size() && i < 6; i++) {
                    Uri uri = uris.get(i);
                    String mime = "";
                    try {
                        mime = act.getContentResolver().getType(uri);
                    } catch (Exception ignored) {
                    }
                    if (mime == null) mime = "";
                    String name = displayName(uri);
                    MediaFiles.Item item = null;
                    if (mime.startsWith("image/")) {
                        item = MediaFiles.addImage(ctx, uri, name);
                    } else if (mime.startsWith("video/")) {
                        item = MediaFiles.addVideo(ctx, uri, name, mime);
                    }
                    if (item == null) {
                        failed++;
                        continue;
                    }
                    try {
                        JSONObject o = new JSONObject();
                        o.put("id", item.id);
                        o.put("type", item.type);
                        o.put("mime", item.mime);
                        o.put("name", item.name);
                        o.put("thumb", item.thumb);
                        o.put("size", item.size);
                        out.put(o);
                    } catch (Exception ignored) {
                    }
                }
                if (out.length() == 0) {
                    final String msg = failed > 0
                            ? "无法读取所选文件，请确认图片不超过 5MB、视频不超过 8MB"
                            : "未选择文件";
                    act.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(act, msg, Toast.LENGTH_LONG).show();
                        }
                    });
                }
                eval("window.__api&&window.__api.onMedia(" + JSONObject.quote(out.toString()) + ")");
            }
        }).start();
    }

    private String displayName(Uri uri) {
        Cursor c = null;
        try {
            c = act.getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String s = c.getString(idx);
                    if (s != null && !s.isEmpty()) return s;
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (c != null) c.close();
        }
        return "附件";
    }

    private void eval(final String js) {
        web.post(new Runnable() {
            @Override
            public void run() {
                try {
                    web.evaluateJavascript(js, null);
                } catch (Exception ignored) {
                }
            }
        });
    }
}
