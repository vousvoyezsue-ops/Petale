/* ═══════════════════════════════════════════════════════
   Petale Social — Supabase 기반 친구 · 학습 기록 공유
   테이블: petale_profiles / petale_friendships / petale_daily_stats
   ═══════════════════════════════════════════════════════ */

const Social = (() => {
  // ⚠️ 전용 프로젝트로 옮길 때 이 두 값만 새 프로젝트의 URL·publishable(anon) 키로 교체하세요.
  //    (Supabase 대시보드 → Project Settings → API)
  const SUPABASE_URL = "https://fdlyrqelvnenmsufqwod.supabase.co";
  const SUPABASE_KEY = "sb_publishable_zuUgSnSycBDd1C4mw_94Uw_RW2usHTB";

  let client = null;
  let profile = null; // { id, username }

  function sb() {
    client ??= supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        // implicit: 토큰이 URL 해시(#)로 돌아온다. 해시는 서버로 안 가고
        // GitHub Pages의 경로 리다이렉트에도 살아남아 ?code=가 유실되는 문제를 피한다.
        flowType: "implicit",
      },
    });
    return client;
  }

  let lastAuthError = null;
  function consumeAuthError() { const e = lastAuthError; lastAuthError = null; return e; }

  async function currentUser() {
    const { data } = await sb().auth.getSession();
    return data.session?.user ?? null;
  }

  function sanitizeUsername(raw) {
    let u = (raw || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    if (u.length < 3) u = "user_" + Math.random().toString(36).slice(2, 8);
    return u.slice(0, 20);
  }

  // 로그인 직후: 프로필이 없으면 생성.
  // 이메일 가입은 사용자가 고른 username을 쓰고 중복이면 오류를 알린다.
  // 소셜 로그인은 username이 없으니 이메일/이름에서 자동 생성하고 중복 시 접미사로 재시도한다.
  function cacheProfile() {
    try { if (profile) localStorage.setItem("petale.profile", JSON.stringify(profile)); } catch { /* 무시 */ }
  }

  async function ensureProfile() {
    const user = await currentUser();
    if (!user) { profile = null; return null; }

    const { data: existing } = await sb()
      .from("petale_profiles").select("id, username").eq("id", user.id).maybeSingle();
    if (existing) { profile = existing; cacheProfile(); return profile; }

    const chosen = localStorage.getItem("petale.pendingUsername"); // 이메일 가입 시 사용자가 고른 값
    const auto = !chosen;
    let wanted = sanitizeUsername(chosen
      || user.user_metadata?.petale_username
      || user.user_metadata?.name
      || (user.email ? user.email.split("@")[0] : "")
      || "user_" + user.id.slice(0, 8));

    for (let attempt = 0; attempt < 5; attempt++) {
      const { data: created, error } = await sb()
        .from("petale_profiles")
        .insert({ id: user.id, username: wanted })
        .select("id, username")
        .single();
      if (!error) {
        localStorage.removeItem("petale.pendingUsername");
        profile = created;
        cacheProfile();
        return profile;
      }
      if (error.code !== "23505") throw error;
      // 중복: 사용자가 직접 고른 이름이면 알리고, 자동 생성이면 접미사 붙여 재시도
      if (!auto) throw new Error("username_taken");
      wanted = sanitizeUsername(wanted.slice(0, 15) + Math.random().toString(36).slice(2, 5));
    }
    throw new Error("username_taken");
  }

  async function signUp(email, password, username) {
    username = username.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) throw new Error("bad_username");
    // 세션이 생기기 전(메일 인증 대기)에도 기억해두었다가 첫 로그인 때 사용
    localStorage.setItem("petale.pendingUsername", username);
    const { data, error } = await sb().auth.signUp({
      email, password,
      options: { data: { petale_username: username } },
    });
    if (error) throw error;
    if (data.session) await ensureProfile();
    return { needsConfirm: !data.session };
  }

  async function signIn(email, password) {
    const { error } = await sb().auth.signInWithPassword({ email, password });
    if (error) throw error;
    await ensureProfile();
    await pushStats();
  }

  // 구글 소셜 로그인 — 현재 페이지로 되돌아온다(리다이렉트 방식).
  // 돌아온 뒤 init()/ensureProfile()가 세션을 복원한다.
  async function signInWithGoogle() {
    const redirectTo = location.href.split("#")[0].split("?")[0];
    const { error } = await sb().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });
    if (error) throw error;
    // 성공 시 브라우저가 구글로 이동하므로 이 아래는 실행되지 않는다.
  }

  async function signOut() {
    await sb().auth.signOut();
    profile = null;
    try { localStorage.removeItem("petale.profile"); } catch { /* 무시 */ }
  }

  /* ── 컬렉션(덱·카드 전체) 클라우드 동기화 ── */
  const OWNER_KEY = "petale.owner"; // 이 브라우저의 로컬 데이터가 속한 계정

  async function pullCollection() {
    if (!profile) return null;
    const { data, error } = await sb()
      .from("petale_collections")
      .select("data, updated_at")
      .eq("user_id", profile.id)
      .maybeSingle();
    if (error) throw error;
    return data; // { data, updated_at } | null
  }

  async function pushCollection() {
    if (!profile) return;
    // 이미지(media)는 서버에 올리지 않는다 — 용량이 크고 기기에만 보관(Anki 방식).
    // 덱·카드·설정 등 텍스트/구조만 동기화한다.
    const { media, ...noMedia } = Store.state;
    const { error } = await sb().from("petale_collections").upsert(
      { user_id: profile.id, data: noMedia, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) throw error;
  }

  // 변경 후 디바운스 푸시 — 저장 훅에서 호출. 실패해도 앱 흐름을 막지 않는다.
  let pushTimer = null;
  function schedulePush() {
    if (!profile) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushCollection().catch(() => {});
      syncMediaUp().catch(() => {}); // 새 이미지도 서버로
    }, 1500);
  }

  /* ── 이미지(미디어) 스토리지 동기화 ──
     이미지는 컬렉션 JSON이 아니라 Supabase Storage에 개별 파일로 올린다.
     경로: {소유자id}/{mediaId}. 다른 기기는 카드의 imageId로 내려받는다. */
  const MEDIA_BUCKET = "petale-media";
  let uploaded = null; // 이미 올린 mediaId 집합 (계정별 로컬 캐시)

  function uploadedKey() { return `petale.mediaUp.${profile ? profile.id : "none"}`; }
  function loadUploaded() {
    try { uploaded = new Set(JSON.parse(localStorage.getItem(uploadedKey()) || "[]")); }
    catch { uploaded = new Set(); }
  }
  function saveUploaded() {
    try { localStorage.setItem(uploadedKey(), JSON.stringify([...uploaded])); } catch { /* 무시 */ }
  }

  function dataURLtoBlob(dataURL) {
    const [head, b64] = dataURL.split(",");
    const mime = (head.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  async function uploadMedia(mediaId, dataURL) {
    try {
      const blob = dataURLtoBlob(dataURL);
      const { error } = await sb().storage.from(MEDIA_BUCKET)
        .upload(`${profile.id}/${mediaId}`, blob, { upsert: true, contentType: blob.type });
      return !error;
    } catch { return false; }
  }
  async function downloadMedia(ownerId, mediaId) {
    try {
      const { data, error } = await sb().storage.from(MEDIA_BUCKET).download(`${ownerId}/${mediaId}`);
      if (error || !data) return null;
      return await blobToDataURL(data);
    } catch { return null; }
  }

  // 로컬에 있으나 아직 안 올라간 이미지 업로드
  async function syncMediaUp() {
    if (!profile) return;
    if (!uploaded) loadUploaded();
    for (const id of Store.referencedMedia()) {
      if (uploaded.has(id)) continue;
      const dataURL = Store.getMedia(id);
      if (!dataURL) continue;
      if (await uploadMedia(id, dataURL)) { uploaded.add(id); saveUploaded(); }
    }
  }

  // 로컬에 없는(다른 기기에서 만든) 이미지 내려받기. 받을 때마다 onUpdate 호출.
  async function syncMediaDown(onUpdate) {
    if (!profile) return;
    let got = 0;
    for (const id of Store.referencedMedia()) {
      if (Store.getMedia(id)) continue;
      const dataURL = await downloadMedia(profile.id, id);
      if (dataURL) { Store.putMedia(id, dataURL); got++; if (onUpdate) onUpdate(); }
    }
    return got;
  }

  // 로그인 후 양방향 미디어 동기화 (백그라운드)
  function syncMedia(onUpdate) {
    if (!profile) return;
    loadUploaded();
    syncMediaUp().catch(() => {});
    syncMediaDown(onUpdate).catch(() => {});
  }

  // 로그인 직후 1회: 서버·로컬 중 최신본을 채택(계정 단위 last-writer-wins).
  // 다른 계정으로 바뀌었으면 이전 사용자 데이터가 새 계정에 섞이지 않게 처리한다.
  async function syncOnLogin() {
    if (!profile) return { pulled: false };
    const localOwner = localStorage.getItem(OWNER_KEY);
    const sameOwner = localOwner === profile.id;
    // 이전에 '다른 계정'으로 로그인한 흔적이 있을 때만 남의 데이터로 취급.
    // 로그인 이력이 없으면(null) 로컬은 이 사용자의 게스트 데이터 → 보존/업로드.
    const foreignOwner = !!localOwner && localOwner !== profile.id;
    let remote = null;
    try { remote = await pullCollection(); } catch { return { pulled: false, offline: true }; }

    let pulled = false;
    if (remote && remote.data && Object.keys(remote.data).length) {
      const remoteAt = new Date(remote.updated_at).getTime();
      if (sameOwner && Store.state.updatedAt > remoteAt) {
        await pushCollection().catch(() => {}); // 같은 사용자의 오프라인 변경이 더 최신
      } else {
        Store.replaceState(remote.data); // 서버본 채택
        pulled = true;
      }
    } else {
      // 서버에 데이터 없음(신규 계정). 다른 계정 데이터가 남아있으면 리셋 후 업로드.
      if (foreignOwner) { Store.reset(); pulled = true; }
      await pushCollection().catch(() => {}); // 첫 로그인이면 게스트 데이터를 그대로 업로드
    }
    localStorage.setItem(OWNER_KEY, profile.id);
    return { pulled };
  }

  /* ── 학습 기록 동기화 ── */
  async function pushStats() {
    if (!profile) return;
    const day = Store.todayKey();
    const reviews = Store.state.reviews[day] || 0;
    const streak = Store.streak();
    await sb().from("petale_daily_stats").upsert(
      { user_id: profile.id, day, reviews, streak, updated_at: new Date().toISOString() },
      { onConflict: "user_id,day" },
    );
  }

  // 복습 직후 호출 — 실패해도 앱 흐름을 막지 않는다
  function pushStatsQuiet() {
    if (!profile) return;
    pushStats().catch(() => {});
  }

  /* ── 친구 ── */
  async function sendRequest(username) {
    username = username.trim().toLowerCase();
    if (!profile) throw new Error("not_signed_in");
    if (username === profile.username) throw new Error("self");

    const { data: target } = await sb()
      .from("petale_profiles").select("id, username").eq("username", username).maybeSingle();
    if (!target) throw new Error("not_found");

    const { error } = await sb().from("petale_friendships")
      .insert({ requester: profile.id, addressee: target.id });
    if (error) {
      if (error.code === "23505") throw new Error("already");
      throw error;
    }
  }

  async function respondRequest(id, accept) {
    if (accept) {
      await sb().from("petale_friendships").update({ status: "accepted" }).eq("id", id);
    } else {
      await sb().from("petale_friendships").delete().eq("id", id);
    }
  }

  // 친구 목록 + 받은 요청 + 각 친구의 오늘 기록
  async function fetchOverview() {
    if (!profile) return null;

    const { data: ships } = await sb()
      .from("petale_friendships")
      .select("id, requester, addressee, status, req:petale_profiles!requester(username), addr:petale_profiles!addressee(username)");

    const incoming = [];
    const friends = [];
    for (const s of ships || []) {
      if (s.status === "pending") {
        if (s.addressee === profile.id) {
          incoming.push({ id: s.id, username: s.req?.username || "?" });
        }
        continue;
      }
      const other = s.requester === profile.id
        ? { id: s.addressee, username: s.addr?.username }
        : { id: s.requester, username: s.req?.username };
      friends.push(other);
    }

    // 친구들의 최신 기록(오늘 + 최근 streak)
    let stats = {};
    if (friends.length) {
      const ids = friends.map(f => f.id);
      const { data: rows } = await sb()
        .from("petale_daily_stats")
        .select("user_id, day, reviews, streak")
        .in("user_id", ids)
        .order("day", { ascending: false });
      for (const r of rows || []) {
        stats[r.user_id] ??= { today: 0, streak: r.streak };
        if (r.day === Store.todayKey()) stats[r.user_id].today = r.reviews;
      }
    }

    return { profile, incoming, friends, stats };
  }

  /* ── 공개 덱 공유/검색 ── */
  const SHARED_MEDIA_BUCKET = "petale-shared-media";

  // 텍스트(기본/빈칸) + 이미지 카드(기본 이미지/이미지 가리기) 모두 payload로 공유한다.
  // 이미지 자체는 Storage에 별도 업로드하고, payload에는 storage 경로만 남긴다.
  function sharablePayload(cards) {
    return cards
      .filter(c => !c.suspended && (c.type === "basic" || c.type === "cloze" || c.type === "occlusion"))
      .slice(0, 2000);
  }

  function dataURLtoBlob(dataURL) {
    const [head, b64] = dataURL.split(",");
    const mime = /data:(.*?);base64/.exec(head)?.[1] || "image/png";
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }
  function extFromMime(mime) {
    if (mime.includes("png")) return "png";
    if (mime.includes("webp")) return "webp";
    if (mime.includes("gif")) return "gif";
    return "jpg";
  }

  // 덱 공개(업서트) — visibility: "public" | "friends"
  // 1) 메타데이터만 먼저 업서트해 안정적인 sharedId 확보
  // 2) 카드가 참조하는 이미지들을 {owner}/{sharedId}/{imageId}.ext 경로로 업로드
  // 3) 이미지 경로를 채운 최종 payload로 갱신
  async function publishDeck(deck, cards, visibility = "public") {
    if (!profile) throw new Error("not_signed_in");
    const rows = sharablePayload(cards);
    if (!rows.length) throw new Error("no_text_cards");

    const { data: row, error: upErr } = await sb().from("petale_shared_decks")
      .upsert({
        owner: profile.id,
        name: deck.name.slice(0, 60),
        description: (deck.desc || "").slice(0, 200),
        card_count: rows.length,
        visibility,
        payload: { cards: [] }, // 이미지 업로드 후 아래에서 채워 넣음
        updated_at: new Date().toISOString(),
      }, { onConflict: "owner,name" })
      .select("id")
      .single();
    if (upErr) throw upErr;
    const sharedId = row.id;

    // 카드가 참조하는 로컬 이미지 id 전부 수집(occlusion은 여러 카드가 같은 이미지를 공유)
    const imageIds = new Set();
    for (const c of rows) {
      if (c.type === "occlusion" && c.imageId) imageIds.add(c.imageId);
      if (c.frontImageId) imageIds.add(c.frontImageId);
      if (c.backImageId) imageIds.add(c.backImageId);
    }
    const pathOf = {};
    for (const imageId of imageIds) {
      const dataURL = Store.getMedia(imageId);
      if (!dataURL) continue;
      const blob = dataURLtoBlob(dataURL);
      const path = `${profile.id}/${sharedId}/${imageId}.${extFromMime(blob.type)}`;
      const { error: upErr2 } = await sb().storage.from(SHARED_MEDIA_BUCKET)
        .upload(path, blob, { upsert: true, contentType: blob.type });
      if (!upErr2) pathOf[imageId] = path;
    }

    const finalCards = rows.map(c => {
      if (c.type === "cloze") return { type: "cloze", front: c.front, clozeIndex: c.clozeIndex };
      if (c.type === "occlusion") {
        return {
          type: "occlusion", front: c.front, rects: c.rects, hideIndex: c.hideIndex, occMode: c.occMode,
          imagePath: pathOf[c.imageId] || null,
        };
      }
      return {
        type: "basic", front: c.front, back: c.back,
        frontImagePath: c.frontImageId ? (pathOf[c.frontImageId] || null) : null,
        backImagePath: c.backImageId ? (pathOf[c.backImageId] || null) : null,
      };
    });

    const { error: finalErr } = await sb().from("petale_shared_decks")
      .update({ payload: { cards: finalCards }, card_count: finalCards.length, visibility, updated_at: new Date().toISOString() })
      .eq("id", sharedId);
    if (finalErr) throw finalErr;

    return { sharedId, count: finalCards.length };
  }

  async function unpublishDeck(sharedId) {
    if (!profile) throw new Error("not_signed_in");
    // 업로드된 이미지도 함께 정리(베스트 에포트 — 실패해도 행 삭제는 진행)
    try {
      const prefix = `${profile.id}/${sharedId}`;
      const { data: files } = await sb().storage.from(SHARED_MEDIA_BUCKET).list(prefix);
      if (files?.length) {
        await sb().storage.from(SHARED_MEDIA_BUCKET).remove(files.map(f => `${prefix}/${f.name}`));
      }
    } catch {}
    const { error } = await sb().from("petale_shared_decks").delete().eq("id", sharedId);
    if (error) throw error;
  }

  // 검색 — 로그인 없이 사용 가능(공개 덱만 보임). 빈 검색어면 인기순 상위.
  // ownerIds가 주어지면 그 사용자들(친구)이 공유한 덱만 검색한다.
  async function searchDecks(query, ownerIds) {
    if (Array.isArray(ownerIds) && ownerIds.length === 0) return []; // 친구 없음 → 결과 없음
    let req = sb().from("petale_shared_decks")
      .select("id, name, description, card_count, downloads, created_at, owner, visibility, petale_profiles(username)")
      .order("downloads", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(30);
    const q = query.trim().replaceAll(",", " ");
    if (q) req = req.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    if (Array.isArray(ownerIds)) req = req.in("owner", ownerIds);
    const { data, error } = await req;
    if (error) throw error;
    return (data || []).map(d => ({
      id: d.id,
      name: d.name,
      description: d.description,
      cardCount: d.card_count,
      downloads: d.downloads,
      author: d.petale_profiles?.username || "?",
      visibility: d.visibility,
    }));
  }

  // 공개 덱을 내 컬렉션으로 복사 — 이미지가 있으면 서명된 URL로 받아와 로컬에 저장
  async function downloadDeck(sharedId) {
    const { data, error } = await sb().from("petale_shared_decks")
      .select("name, description, payload").eq("id", sharedId).single();
    if (error || !data) throw error || new Error("not_found");
    const rawCards = (data.payload?.cards || []).filter(c => c && (c.type === "basic" || c.type === "cloze" || c.type === "occlusion"));
    if (!rawCards.length) throw new Error("empty");

    // 이 다운로드에서 등장하는 storage 경로들을 한 번씩만 받아서 로컬 imageId로 매핑
    const pathToLocalId = {};
    async function localIdFor(path) {
      if (!path) return null;
      if (pathToLocalId[path]) return pathToLocalId[path];
      try {
        const { data: signed } = await sb().storage.from(SHARED_MEDIA_BUCKET).createSignedUrl(path, 3600);
        if (!signed?.signedUrl) return null;
        const res = await fetch(signed.signedUrl);
        const blob = await res.blob();
        const dataURL = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = reject;
          r.readAsDataURL(blob);
        });
        const localId = Store.addMedia(dataURL);
        pathToLocalId[path] = localId;
        return localId;
      } catch { return null; }
    }

    const cards = [];
    for (const c of rawCards) {
      if (c.type === "cloze") {
        cards.push({ type: "cloze", front: c.front, back: "", clozeIndex: Number(c.clozeIndex) || 1 });
      } else if (c.type === "occlusion") {
        const imageId = await localIdFor(c.imagePath);
        if (!imageId) continue; // 이미지 못 받아오면 이 카드는 건너뜀
        cards.push({ type: "occlusion", front: c.front || "", imageId, rects: c.rects || [], hideIndex: c.hideIndex || 0, occMode: c.occMode || "one" });
      } else {
        const frontImageId = c.frontImagePath ? await localIdFor(c.frontImagePath) : null;
        const backImageId = c.backImagePath ? await localIdFor(c.backImagePath) : null;
        cards.push({ type: "basic", front: String(c.front || ""), back: String(c.back || ""), frontImageId, backImageId });
      }
    }
    if (!cards.length) throw new Error("empty");

    const deck = Store.addDeck(data.name.slice(0, 60), data.description || "");
    Store.bulkAddCards(deck.id, cards);
    sb().rpc("petale_bump_downloads", { p_deck: sharedId }).then(() => {}, () => {});
    return { deck, count: cards.length };
  }

  function cleanUrl() {
    try { history.replaceState({}, document.title, location.origin + location.pathname); } catch {}
  }

  // OAuth 리다이렉트 복귀 처리. 실패 원인은 lastAuthError에 담아 게이트에 표시한다.
  // implicit(#access_token) 우선, 혹시 모를 pkce(?code=)도 함께 처리.
  async function settleOAuthRedirect() {
    const params = new URLSearchParams(location.search);
    const hash = new URLSearchParams(location.hash.replace(/^#/, ""));

    const err = params.get("error_description") || params.get("error")
             || hash.get("error_description") || hash.get("error");
    if (err) {
      lastAuthError = decodeURIComponent(err);
      console.error("[Petale auth] provider error:", lastAuthError);
      cleanUrl();
      return;
    }

    const at = hash.get("access_token");
    const code = params.get("code");
    console.log("[Petale auth] redirect check — access_token:", !!at, "code:", !!code);

    if (at) { // implicit 플로우 (기본)
      try {
        const { data, error } = await sb().auth.setSession({
          access_token: at, refresh_token: hash.get("refresh_token") || "",
        });
        if (error) lastAuthError = error.message;
        else if (!data?.session) lastAuthError = "세션을 만들지 못했어요 (setSession)";
      } catch (e) { lastAuthError = e?.message || String(e); }
      if (lastAuthError) console.error("[Petale auth] setSession failed:", lastAuthError);
      cleanUrl();
      return;
    }

    if (code) { // pkce 플로우 (대비)
      try {
        const { data, error } = await sb().auth.exchangeCodeForSession(code);
        if (error) lastAuthError = error.message;
        else if (!data?.session) lastAuthError = "세션을 만들지 못했어요 (code exchange)";
      } catch (e) { lastAuthError = e?.message || String(e); }
      if (lastAuthError) console.error("[Petale auth] code exchange failed:", lastAuthError);
      cleanUrl();
    }
  }

  async function init() {
    try {
      await settleOAuthRedirect();
      const user = await currentUser();
      if (!user) { profile = null; return null; } // 진짜 로그아웃 상태

      // 세션이 유효하면 로그인 유지. 프로필 조회는 실패해도 캐시/세션으로 버틴다.
      try {
        await ensureProfile();
        if (profile) { try { localStorage.setItem("petale.profile", JSON.stringify(profile)); } catch {} }
      } catch (e) {
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem("petale.profile") || "null"); } catch {}
        profile = (cached && cached.id === user.id)
          ? cached
          : { id: user.id, username: sanitizeUsername(user.email ? user.email.split("@")[0] : "user") };
        console.warn("[Petale auth] profile fetch failed — staying signed in with cached identity", e);
      }
      return profile;
    } catch (e) {
      if (!lastAuthError) lastAuthError = e?.message || String(e);
      console.error("[Petale auth] init failed:", lastAuthError, e);
      return null;
    }
  }

  // 앱이 다시 보일 때 세션 갱신 — 오래 방치 후에도 로그인 유지
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && client) { client.auth.getSession().catch(() => {}); }
    });
  }

  return {
    init, signUp, signIn, signInWithGoogle, signOut, consumeAuthError,
    sendRequest, respondRequest, fetchOverview,
    pushStats, pushStatsQuiet,
    syncOnLogin, schedulePush, pushCollection, syncMedia,
    publishDeck, unpublishDeck, searchDecks, downloadDeck,
    get profile() { return profile; },
  };
})();
