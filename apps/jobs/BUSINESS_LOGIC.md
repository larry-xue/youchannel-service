# Jobs 鏈嶅姟涓氬姟閫昏緫鏂囨。

## 绯荤粺姒傝堪

Jobs 鏈嶅姟鏄竴涓熀浜?`pg-boss` 鐨勫紓姝ヤ换鍔″鐞嗙郴缁燂紝涓昏璐熻矗锛?
1. 澶勭悊瑙嗛鍒嗘瀽浠诲姟
2. 鎻愪緵绠＄悊鍚庡彴 API

## 鏍稿績缁勪欢

### 1. 浠诲姟闃熷垪绯荤粺

浣跨敤 `pg-boss` 浣滀负浠诲姟闃熷垪寮曟搸锛屽熀浜?PostgreSQL 瀹炵幇鍒嗗竷寮忎换鍔¤皟搴︺€?

**涓昏闃熷垪锛?*
- `analyze.video`: 瑙嗛鍒嗘瀽浠诲姟闃熷垪

### 2. 鏁版嵁搴撹繛鎺?

- **PostgreSQL**: 涓绘暟鎹簱锛屽瓨鍌ㄤ笟鍔℃暟鎹拰浠诲姟鐘舵€?
- **Supabase**: 鐢ㄤ簬鐢ㄦ埛璁よ瘉鍜岀鐞?

## 鏍稿績涓氬姟娴佺▼

### 娴佺▼ 1: 瑙嗛鍒嗘瀽浠诲姟鍏ラ槦锛坋nqueueAnalyses锛?

**瑙﹀彂鏃舵満锛?*
- OpenAPI 鎺ュ彛鎵嬪姩瑙﹀彂
- 鍚庡彴绠＄悊鍛樻帴鍙ｆ墜鍔ㄨЕ鍙?

**澶勭悊閫昏緫锛?*

```
1. 绛涢€夊€欓€夎棰?
   - 杩囨护鏃堕暱瓒呰繃 3600 绉掔殑瑙嗛
   - 璁＄畻鎻愮ず璇嶅搱甯岋紙SHA256锛?

2. 妫€鏌ュ凡瀛樺湪鐨勫垎鏋?
   - 鏌ヨ video_analyses 琛?
   - 杩囨护宸插瓨鍦ㄧ浉鍚?videoId + promptHash 鐨勮褰?

3. 妫€鏌ョ敤鎴烽厤棰?
   - 鏌ヨ user_quotas 琛?
   - 璁＄畻鍓╀綑閰嶉锛歮ax_analyses - analysis_count
   - 鍙叆闃熷墿浣欓厤棰濊寖鍥村唴鐨勮棰?

4. 鍙戦€佸垎鏋愪换鍔?
   - 闃熷垪锛歛nalyze.video
   - 鍗曚緥閿細analysis.{videoId}.{promptHash}
   - 鏇存柊閰嶉璁℃暟

5. 杩斿洖缁熻缁撴灉
   - enqueued: 鎴愬姛鍏ラ槦鐨勬暟閲?
   - skipped: 璺宠繃鐨勬暟閲?
   - skipReasons: 璺宠繃鍘熷洜缁熻
```

### 娴佺▼ 2: 瑙嗛鍒嗘瀽浠诲姟澶勭悊锛坅nalyze.video worker锛?

**浠诲姟鍙傛暟锛?*
```typescript
{
  videoId: string;
  userId: string;
  prompt: string;
}
```

**鎵ц娴佺▼锛?*

```
1. 楠岃瘉瑙嗛
   - 鏌ヨ瑙嗛淇℃伅
   - 妫€鏌ヨ棰戞槸鍚﹀瓨鍦?
   - 楠岃瘉 userId 鍖归厤

2. 妫€鏌ョ幇鏈夊垎鏋愯褰?
   - 璺宠繃宸插畬鎴愭垨姝ｅ湪澶勭悊鐨勫垎鏋?
   - 鍥炴敹瓒呮椂鐨勫鐞嗕腑鐘舵€侊紙15鍒嗛挓锛?

3. 妫€鏌ヨ棰戞潯浠?
   - 瑙嗛鏃堕暱涓嶈秴杩?3600 绉?
   - 瑙嗛 status 涓?'active'

4. 璋冪敤 Gemini API
   - 浣跨敤瑙嗛 URL 鍜屽垎鏋?prompt
   - 杩斿洖缁撴瀯鍖?JSON 缁撴灉

5. 瑙ｆ瀽骞朵繚瀛樼粨鏋?
   - 楠岃瘉杈撳嚭鏍煎紡
   - 淇濆瓨鍒?video_analyses 琛?

6. 閿欒澶勭悊
   - 鍙噸璇曢敊璇紙429/5xx/瓒呮椂锛夛細鎶涘嚭寮傚父瑙﹀彂閲嶈瘯
   - 涓嶅彲閲嶈瘯閿欒锛氭爣璁颁负 failed锛岄€€杩橀厤棰?
```

## 鏁版嵁搴撹〃缁撴瀯

### 鏍稿績琛?

1. **videos**
   - Stores video records.
   - Key fields: `user_id` (owner), `status` (pending/active/error).
   - Unique: `(user_id, youtube_video_id)`

2. **video_analyses**
   - Stores analysis records per video.
   - Unique: `(video_id)` (one analysis per video).

3. **user_quotas**
   - Manages per-user analysis quota.
   - Fields: `analysis_count`, `max_analyses`.

4. **youtube_accounts**
   - Stores YouTube OAuth credentials.
   - YouTube 璐﹀彿璁よ瘉淇℃伅

## 绠＄悊鍚庡彴 API

### 璁よ瘉
- 浣跨敤 Supabase Auth 杩涜韬唤楠岃瘉
- 璇锋眰澶达細`Authorization: Bearer <token>`
- 楠岃瘉娴佺▼锛?
  1. 浠?Authorization 澶存彁鍙?token
  2. 浣跨敤 Supabase 楠岃瘉 token 骞惰幏鍙栫敤鎴蜂俊鎭?
  3. 鏌ヨ `admin_users` 琛ㄧ‘璁ょ敤鎴锋槸鍚︿负绠＄悊鍛?
  4. 楠岃瘉澶辫触杩斿洖 401锛坢issing_token/invalid_token锛夋垨 403锛坣ot_admin锛?

### 涓昏鎺ュ彛

1. **POST /admin/analysis**
   - 绠＄悊鍛樿Е鍙戝垎鏋愪换鍔″叆闃?
   - 鍙傛暟锛歶serId锛堝彲閫夛級, videoIds锛堝彲閫夛級, limit锛堝彲閫夛級
   - 杩斿洖锛歟nqueued/skipped/skipReasons

2. **GET /admin/videos**
   - 绠＄悊鍛樻煡璇㈣棰戝垪琛?
   - 鍙傛暟锛歶serId锛堝彲閫夛級, status锛堝彲閫夛級, limit锛堝彲閫夛級, offset锛堝彲閫夛級
   - 杩斿洖锛氳棰戝垪琛?+ 鏈€鏂板垎鏋愪俊鎭?

3. **GET /admin/users**
   - 鏌ヨ绠＄悊鍛樼敤鎴峰垪琛?

4. **POST /admin/users**
   - 娣诲姞绠＄悊鍛樼敤鎴?
   - 鍙傛暟锛歟mail, password锛堝彲閫夛級, createIfNotExists锛堝彲閫夛級

5. **DELETE /admin/users/:userId**
   - 鍒犻櫎绠＄悊鍛樼敤鎴凤紙涓嶈兘鍒犻櫎鑷繁锛?

6. **GET /admin/system-users**
   - 鏌ヨ绯荤粺鎵€鏈夌敤鎴峰強鍏?YouTube 璐﹀彿淇℃伅

### OpenAPI 鎺ュ彛
- 閴存潈锛氬叡浜瘑閽ワ紙`OPENAPI_SHARED_KEY`锛夛紝鍙€氳繃 `x-openapi-key` 鎴?`Authorization: Bearer <key>` 浼犻€?
- acting user锛氱敱璇锋眰浣撲腑鐨?userId 鎸囧畾锛屾湇鍔＄浼氬仛璧勬簮褰掑睘鏍￠獙

1. **POST /openapi/analysis**
   - 瑙﹀彂鍒嗘瀽浠诲姟鍏ラ槦
   - 鍙傛暟锛歶serId锛堝繀濉級, videoIds锛堝彲閫夛級, limit锛堝彲閫夛級
   - 鏍￠獙锛歷ideo 蹇呴』褰掑睘 userId
   - 杩斿洖锛歟nqueued/skipped/skipReasons

### 闈欐€佹枃浠舵湇鍔?
- 鎻愪緵 admin 鍓嶇鐨勯潤鎬佹枃浠舵湇鍔?
- SPA 璺敱鍥為€€锛氶潪 API 璺敱杩斿洖 index.html

## 閰嶇疆椤?

| 鐜鍙橀噺 | 璇存槑 | 榛樿鍊?|
|---------|------|--------|
| `PORT` | 鏈嶅姟绔彛 | 4000 |
| `DATABASE_URL` | PostgreSQL 杩炴帴瀛楃涓?| 蹇呭～ |
| `SUPABASE_URL` | Supabase 椤圭洰 URL | 蹇呭～ |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 鏈嶅姟瑙掕壊瀵嗛挜 | 蹇呭～ |
| `ADMIN_ORIGIN` | 绠＄悊鍚庡彴鍏佽鐨勬簮 | http://localhost:5173 |
| `OPENAPI_SHARED_KEY` | OpenAPI 鍏变韩瀵嗛挜 | 蹇呭～ |
| `LOG_LEVEL` | 鏃ュ織绾у埆 | info |
| `SENTRY_DSN` | Sentry DSN锛堝彲閫夛級 | - |
| `SENTRY_ENV` | Sentry 鐜锛堝彲閫夛級 | - |
| `GEMINI_API_KEY` | Gemini API Key锛堢敤浜庡垎鏋愶級 | - |
| `GEMINI_MODEL` | Gemini 妯″瀷鍚嶇О | gemini-1.5-flash |

## 鍏抽敭甯搁噺

- `ANALYSIS_MAX_DURATION_SEC`: 3600锛? 灏忔椂锛? 瑙嗛鍒嗘瀽鐨勬渶澶ф椂闀块檺鍒?
- `ANALYSIS_PROCESSING_TIMEOUT_MS`: 15 鍒嗛挓 - 澶勭悊瓒呮椂鏃堕棿

## 閿欒鐩戞帶

- 闆嗘垚 Sentry 杩涜閿欒杩借釜
- 鍏抽敭閿欒鐐癸細
  - Gemini API 璋冪敤澶辫触
  - 鏁版嵁搴撴搷浣滃紓甯?
  - 浠诲姟澶勭悊寮傚父

## 绯荤粺鍚姩娴佺▼

```
1. 鍔犺浇鐜閰嶇疆
2. 鍒濆鍖?Logger
3. 鍒濆鍖?Sentry锛堝鏋滈厤缃簡 DSN锛?
4. 杩炴帴 PostgreSQL锛坧g-boss + 涓氬姟鏁版嵁搴擄級
5. 杩炴帴 Supabase
6. 鍚姩 pg-boss
7. 娉ㄥ唽 Worker锛坅nalyze.video锛?
8. 鍚姩 HTTP 鏈嶅姟鍣紙Fastify锛?
9. 鐩戝惉鍏抽棴淇″彿锛圫IGINT/SIGTERM锛?
```

## 娉ㄦ剰浜嬮」

1. **浠诲姟鍘婚噸**锛氫娇鐢?`singletonKey` 闃叉鍚屼竴瑙嗛鐨勯噸澶嶅垎鏋愪换鍔?
2. **閰嶉绠＄悊**锛氳棰戝垎鏋愪换鍔″彈鐢ㄦ埛閰嶉闄愬埗
3. **閿欒鎭㈠**锛氬垎鏋愬け璐ヤ細閫€杩橀厤棰?
