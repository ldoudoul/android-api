package com.lightchat.app;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLException;

final class ApiClient {

    private static final ExecutorService POOL = Executors.newCachedThreadPool();
    private static final Map<String, HttpURLConnection> ACTIVE = new ConcurrentHashMap<String, HttpURLConnection>();
    private static final Map<String, Boolean> CANCELLED = new ConcurrentHashMap<String, Boolean>();

    private ApiClient() {
    }

    static void chat(final Context ctx, final Bridge bridge, String reqJson) {
        final JSONObject req;
        try {
            req = new JSONObject(reqJson);
        } catch (Exception e) {
            return;
        }
        final String rid = req.optString("id", "");
        if (rid.isEmpty()) return;
        CANCELLED.remove(rid);
        POOL.execute(new Runnable() {
            @Override
            public void run() {
                runChat(ctx, bridge, rid, req);
            }
        });
    }

    static void cancel(String id) {
        CANCELLED.put(id, Boolean.TRUE);
        HttpURLConnection c = ACTIVE.remove(id);
        if (c != null) {
            try {
                c.disconnect();
            } catch (Exception ignored) {
            }
        }
        ACTIVE.remove(id);
    }

    private static void runChat(Context ctx, Bridge bridge, String rid, JSONObject req) {
        HttpURLConnection conn = null;
        boolean completed = false;
        try {
            String pid = req.optString("providerId", "");
            JSONObject p = Providers.find(ctx, pid);
            if (p == null) {
                bridge.emitEvent(rid, "error", null, "未找到服务商配置，请到设置中检查");
                return;
            }
            String key = SecureStore.get(ctx, pid);
            if (key == null || key.isEmpty()) {
                bridge.emitEvent(rid, "error", null, "尚未填写 API Key，请到设置中配置");
                return;
            }
            boolean anthropic = "anthropic".equals(p.optString("protocol", "openai"));
            String model = req.optString("model", "");
            if (model.isEmpty()) {
                bridge.emitEvent(rid, "error", null, "请先选择模型");
                return;
            }

            String system = req.optString("systemPrompt", "").trim();
            JSONArray history = req.optJSONArray("messages");
            JSONArray messages = new JSONArray();
            boolean deepseekApi = !anthropic && p.optString("baseUrl", "").toLowerCase().contains("api.deepseek.com");
            if (!anthropic && !system.isEmpty()) {
                JSONObject sys = new JSONObject();
                sys.put("role", "system");
                sys.put("content", system);
                messages.put(sys);
            }
            if (history != null) {
                for (int i = 0; i < history.length(); i++) {
                    JSONObject m = history.optJSONObject(i);
                    if (m == null) continue;
                    String role = m.optString("role", "user");
                String content = optText(m, "content");
                if ("system".equals(role)) continue;
                JSONArray atts = m.optJSONArray("attachments");
                JSONArray parts = null;
                if (atts != null && atts.length() > 0) {
                    if (deepseekApi) {
                        bridge.emitEvent(rid, "error", null, "DeepSeek 接口不支持图片或视频输入，请切换到视觉模型");
                        return;
                    }
                    if (anthropic && hasVideo(atts)) {
                        bridge.emitEvent(rid, "error", null, "Anthropic 接口暂不支持视频输入");
                        return;
                    }
                    parts = buildParts(ctx, atts, anthropic, content);
                }
                if (content.isEmpty() && parts == null) continue;
                    JSONObject item = new JSONObject();
                    item.put("role", role);
                if (parts != null && parts.length() > 0) item.put("content", parts);
                else item.put("content", content);
                    messages.put(item);
                }
            }
            if (messages.length() == 0) {
                bridge.emitEvent(rid, "error", null, "没有可发送的内容");
                return;
            }

            JSONObject body = new JSONObject();
            body.put("model", model);
            boolean stream = req.optBoolean("stream", true);
            body.put("stream", stream);
            body.put("messages", messages);
            double temp = req.optDouble("temperature", 0.7);
            if (temp >= 0) body.put("temperature", temp);
            int maxTokens = req.optInt("maxTokens", 0);
            if (anthropic) {
                body.put("max_tokens", maxTokens > 0 ? maxTokens : 4096);
                if (!system.isEmpty()) body.put("system", system);
            } else if (maxTokens > 0) {
                body.put("max_tokens", maxTokens);
            }

            String base = p.optString("baseUrl", "").trim();
            if (base.isEmpty()) {
                bridge.emitEvent(rid, "error", null, "服务商 Base URL 未填写");
                return;
            }
            String url = anthropic ? anthropicUrl(base, "/messages") : openaiUrl(base, "/chat/completions");

            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(180000);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "text/event-stream");
            conn.setRequestProperty("User-Agent", "LightChat/1.0 (Android)");
            conn.setRequestProperty("Cache-Control", "no-cache");
            if (anthropic) {
                conn.setRequestProperty("x-api-key", key);
                conn.setRequestProperty("anthropic-version", p.optString("anthropicVersion", "2023-06-01"));
            } else {
                conn.setRequestProperty("Authorization", "Bearer " + key);
            }
            JSONObject extra = p.optJSONObject("extraHeaders");
            if (extra != null) {
                Iterator<String> it = extra.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = extra.optString(k, "");
                    if (!k.isEmpty() && !v.isEmpty()) conn.setRequestProperty(k, v);
                }
            }
            ACTIVE.put(rid, conn);

            byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
            OutputStream os = conn.getOutputStream();
            os.write(payload);
            os.flush();
            os.close();

            if (CANCELLED.containsKey(rid)) return;

            int code = conn.getResponseCode();
            if (code < 200 || code >= 300) {
                String detail = readAll(conn.getErrorStream(), 6000);
                String msg = extractError(detail);
                if (msg.isEmpty()) msg = "请求失败（HTTP " + code + "）";
                else if (code == 401 || code == 403) msg = "API Key 无效或无权限：" + msg;
                bridge.emitEvent(rid, "error", null, msg);
                return;
            }

            String ctype = conn.getContentType();
            InputStream is = conn.getInputStream();
            if (!stream) {
                emitWhole(rid, bridge, readAll(is, 4 * 1024 * 1024), anthropic);
            } else if (ctype != null && ctype.toLowerCase().contains("event-stream")) {
                streamSse(rid, bridge, is, anthropic);
            } else {
                emitWhole(rid, bridge, readAll(is, 4 * 1024 * 1024), anthropic);
            }
            completed = true;
        } catch (Exception e) {
            if (!CANCELLED.containsKey(rid)) {
                bridge.emitEvent(rid, "error", null, humanize(e));
            }
        } finally {
            ACTIVE.remove(rid);
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Exception ignored) {
                }
            }
            if (completed && !CANCELLED.containsKey(rid)) {
                bridge.emitEvent(rid, "done", null, null);
            }
            CANCELLED.remove(rid);
        }
    }

    private static String optText(JSONObject o, String key) {
        if (o == null || o.isNull(key)) return "";
        return o.optString(key, "");
    }

    private static boolean hasVideo(JSONArray atts) {
        for (int i = 0; i < atts.length(); i++) {
            JSONObject a = atts.optJSONObject(i);
            if (a != null && "video".equals(a.optString("type", ""))) return true;
        }
        return false;
    }

    private static JSONArray buildParts(Context ctx, JSONArray atts, boolean anthropic, String content) {
        try {
            JSONArray parts = new JSONArray();
            if (!content.isEmpty()) {
                parts.put(new JSONObject().put("type", "text").put("text", content));
            }
            int added = 0;
            for (int i = 0; i < atts.length(); i++) {
                JSONObject a = atts.optJSONObject(i);
                if (a == null) continue;
                String type = a.optString("type", "image");
                File f = MediaFiles.find(ctx, a.optString("id", ""));
                if (f == null || !f.isFile() || f.length() == 0) continue;
                byte[] bytes = readFile(f, 12 * 1024 * 1024);
                if (bytes == null || bytes.length == 0) continue;
                String mime = a.optString("mime", "image".equals(type) ? "image/jpeg" : "video/mp4");
                String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
                if ("image".equals(type)) {
                    JSONObject part;
                    if (anthropic) {
                        part = new JSONObject().put("type", "image").put("source",
                                new JSONObject().put("type", "base64").put("media_type", mime).put("data", b64));
                    } else {
                        part = new JSONObject().put("type", "image_url").put("image_url",
                                new JSONObject().put("url", "data:" + mime + ";base64," + b64));
                    }
                    parts.put(part);
                    added++;
                } else if (!anthropic) {
                    parts.put(new JSONObject().put("type", "video_url").put("video_url",
                            new JSONObject().put("url", "data:" + mime + ";base64," + b64)));
                    added++;
                }
            }
            return added > 0 ? parts : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] readFile(File f, int max) {
        try {
            long len = f.length();
            if (len <= 0 || len > max) return null;
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) len);
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        }
    }

    private static void streamSse(String rid, Bridge bridge, InputStream is, boolean anthropic) throws Exception {
        BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8), 8192);
        String line;
        int deltas = 0;
        JSONObject last = null;
        while ((line = br.readLine()) != null) {
            if (CANCELLED.containsKey(rid)) break;
            if (line.isEmpty()) continue;
            if (!line.startsWith("data:")) continue;
            String data = line.substring(5).trim();
            if (data.isEmpty() || "[DONE]".equals(data)) continue;
            JSONObject o;
            try {
                o = new JSONObject(data);
            } catch (Exception e) {
                continue;
            }
            last = o;
            if (anthropic) {
                if ("content_block_delta".equals(o.optString("type", ""))) {
                    JSONObject d = o.optJSONObject("delta");
                    if (d == null) continue;
                    String dt = d.optString("type", "");
                    if ("text_delta".equals(dt)) {
                        String t = optText(d, "text");
                        if (!t.isEmpty()) {
                            bridge.emitEvent(rid, "delta", t, null);
                            deltas++;
                        }
                    } else if ("thinking_delta".equals(dt)) {
                        String t = optText(d, "thinking");
                        if (!t.isEmpty()) {
                            bridge.emitEvent(rid, "reasoning", t, null);
                            deltas++;
                        }
                    }
                }
            } else {
                JSONArray choices = o.optJSONArray("choices");
                if (choices == null || choices.length() == 0) continue;
                JSONObject ch = choices.optJSONObject(0);
                if (ch == null) continue;
                JSONObject d = ch.optJSONObject("delta");
                if (d == null) d = ch.optJSONObject("message");
                if (d == null) continue;
                String reason = optText(d, "reasoning_content");
                if (reason.isEmpty()) reason = optText(d, "reasoning");
                if (!reason.isEmpty()) {
                    bridge.emitEvent(rid, "reasoning", reason, null);
                    deltas++;
                }
                String text = optText(d, "content");
                if (!text.isEmpty()) {
                    bridge.emitEvent(rid, "delta", text, null);
                    deltas++;
                }
            }
        }
        if (deltas == 0 && last != null) {
            emitObject(rid, bridge, last, anthropic);
        }
    }

    private static void emitWhole(String rid, Bridge bridge, String raw, boolean anthropic) {
        try {
            emitObject(rid, bridge, new JSONObject(raw), anthropic);
        } catch (Exception ignored) {
        }
    }

    private static void emitObject(String rid, Bridge bridge, JSONObject o, boolean anthropic) {
        String text = "";
        String reason = "";
        JSONArray choices = o.optJSONArray("choices");
        if (choices != null && choices.length() > 0) {
            JSONObject ch = choices.optJSONObject(0);
            JSONObject msg = ch == null ? null : ch.optJSONObject("message");
            if (msg == null) msg = ch == null ? null : ch.optJSONObject("delta");
            if (msg != null) {
                text = optText(msg, "content");
                reason = optText(msg, "reasoning_content");
                if (reason.isEmpty()) reason = optText(msg, "reasoning");
            }
        } else if (anthropic) {
            JSONArray blocks = o.optJSONArray("content");
            if (blocks != null) {
                for (int i = 0; i < blocks.length(); i++) {
                    JSONObject b = blocks.optJSONObject(i);
                    if (b == null) continue;
                    String t = b.optString("type", "");
                    if ("text".equals(t)) text += optText(b, "text");
                    else if ("thinking".equals(t)) reason += optText(b, "thinking");
                }
            }
        } else {
            text = optText(o, "content");
        }
        if (!reason.isEmpty()) {
            bridge.emitEvent(rid, "reasoning", reason, null);
        }
        if (!text.isEmpty()) {
            bridge.emitEvent(rid, "delta", text, null);
        }
    }

    static void test(final Context ctx, final Bridge bridge, String cfgJson) {
        JSONObject out = new JSONObject();
        HttpURLConnection c = null;
        try {
            JSONObject cfg = new JSONObject(cfgJson);
            String base = cfg.optString("baseUrl", "").trim();
            String protocol = cfg.optString("protocol", "openai");
            String key = cfg.optString("apiKey", "").trim();
            if (key.isEmpty() && cfg.has("id")) {
                String stored = SecureStore.get(ctx, cfg.optString("id"));
                if (stored != null) key = stored;
            }
            if (base.isEmpty()) {
                out.put("ok", false).put("message", "请先填写 Base URL");
            } else if (key.isEmpty()) {
                out.put("ok", false).put("message", "请先填写 API Key");
            } else {
                boolean anthropic = "anthropic".equals(protocol);
                String url = anthropic ? anthropicUrl(base, "/models") : openaiUrl(base, "/models");
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(15000);
                c.setReadTimeout(20000);
                c.setRequestProperty("Accept", "application/json");
                c.setRequestProperty("User-Agent", "LightChat/1.0 (Android)");
                if (anthropic) {
                    c.setRequestProperty("x-api-key", key);
                    c.setRequestProperty("anthropic-version", "2023-06-01");
                } else {
                    c.setRequestProperty("Authorization", "Bearer " + key);
                }
                int code = c.getResponseCode();
                String body = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream(), 400000);
                if (code >= 200 && code < 300) {
                    JSONArray data = null;
                    try {
                        data = new JSONObject(body).optJSONArray("data");
                    } catch (Exception ignored) {
                    }
                    int n = data == null ? 0 : data.length();
                    out.put("ok", true);
                    out.put("message", n > 0 ? ("连接成功 · " + n + " 个模型可用") : "连接成功");
                    if (data != null) out.put("models", data);
                } else if (code == 404) {
                    out.put("ok", true).put("message", "已连通（该服务未提供 /models，可直接发消息测试）");
                } else if (code == 401 || code == 403) {
                    out.put("ok", false).put("message", "API Key 无效或无权限（HTTP " + code + "）");
                } else {
                    out.put("ok", false).put("message", "HTTP " + code + " · " + clip(extractError(body), 120));
                }
            }
        } catch (Exception e) {
            try {
                out.put("ok", false).put("message", humanize(e));
            } catch (Exception ignored) {
            }
        } finally {
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
            bridge.emitTest(out.toString());
        }
    }

    private static String strip(String b) {
        String s = b == null ? "" : b.trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    private static String openaiUrl(String base, String path) {
        String b = strip(base);
        String low = b.toLowerCase();
        if (low.endsWith("/chat/completions") || low.endsWith("/completions")) return b;
        if (low.matches(".*/v\\d+[a-z0-9]*$") || low.endsWith("/openai")) return b + path;
        return b + "/v1" + path;
    }

    private static String anthropicUrl(String base, String path) {
        String b = strip(base);
        String low = b.toLowerCase();
        if (low.endsWith("/messages") || low.endsWith("/models")) return b;
        if (low.matches(".*/v\\d+$")) return b + path;
        return b + "/v1" + path;
    }

    private static String readAll(InputStream is, int max) {
        if (is == null) return "";
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) {
                int room = max - bos.size();
                if (room <= 0) break;
                bos.write(buf, 0, Math.min(n, room));
            }
            return new String(bos.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        } finally {
            try {
                is.close();
            } catch (Exception ignored) {
            }
        }
    }

    private static String extractError(String body) {
        if (body == null || body.isEmpty()) return "";
        try {
            JSONObject o = new JSONObject(body);
            JSONObject err = o.optJSONObject("error");
            if (err != null) {
                String m = optText(err, "message");
                if (!m.isEmpty()) return m;
            }
            String m = optText(o, "message");
            if (!m.isEmpty()) return m;
        } catch (Exception ignored) {
        }
        return clip(body.replaceAll("\\s+", " ").trim(), 240);
    }

    private static String clip(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(0, n) + "…";
    }

    private static String humanize(Exception e) {
        if (e instanceof UnknownHostException) return "无法解析域名，请检查网络或 Base URL";
        if (e instanceof SocketTimeoutException) return "请求超时，请检查网络后重试";
        if (e instanceof SSLException) return "HTTPS 证书校验失败，请检查 Base URL 或代理";
        if (e instanceof ConnectException) return "无法连接服务器，请检查 Base URL 和网络";
        String m = e.getMessage();
        return "请求出错：" + (m == null ? e.getClass().getSimpleName() : m);
    }
}
