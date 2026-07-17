(() => {
  'use strict';

  const route = location.pathname.split('/').filter(Boolean);
  const role = route[0] === 'host' ? 'host' : 'viewer';
  const routeToken = route[1] || '';
  const hostToken = role === 'host' ? routeToken : '';
  let roomToken = role === 'viewer' ? routeToken : '';
  let socket;
  let lastTimeline = null;
  let currentMediaVersion = null;
  let applyingRemote = false;
  let viewerUnlocked = role === 'host';
  let toastTimer;

  const $ = (id) => document.getElementById(id);
  const player = $('player');
  const hostPanel = $('hostPanel');
  const viewerNote = $('viewerNote');

  function showToast(message) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').classList.remove('hidden');
    toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4200);
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (roomToken) headers['x-room-token'] = roomToken;
    if (hostToken) headers['x-host-token'] = hostToken;
    if (options.body && typeof options.body === 'string') headers['content-type'] = 'application/json';
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
    return `${value.toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }

  function mediaUrl(state) {
    if (!state.movie) return null;
    const kind = state.movie.iphoneAvailable ? 'iphone' : 'source';
    return `/media/${encodeURIComponent(roomToken)}/${kind}?v=${encodeURIComponent(state.movie.version)}`;
  }

  function render(state) {
    $('viewerCount').textContent = `${state.viewerCount || 0} 位观众`;
    const movie = state.movie;
    $('movieName').textContent = movie ? `${movie.name} · ${formatBytes(movie.size)}` : '尚未选择电影';
    $('emptyState').classList.toggle('hidden', Boolean(movie));

    if (movie && currentMediaVersion !== movie.version) {
      currentMediaVersion = movie.version;
      player.src = mediaUrl(state);
      player.load();
    }

    if (role === 'viewer' && movie && !movie.iphoneAvailable && !movie.sourceCompatibleWithIphone && /iP(hone|ad|od)/.test(navigator.userAgent)) {
      $('emptyState').classList.remove('hidden');
      $('emptyTitle').textContent = '正在等待 iPhone 适配';
      $('emptyHint').textContent = '请让主机点击“开始转码”，完成后会自动载入';
    }

    if (role === 'host') {
      const running = state.transcode.status === 'running';
      $('transcodeButton').disabled = !movie || running;
      $('cancelButton').classList.toggle('hidden', !running);
      $('transcodeProgressWrap').classList.toggle('hidden', !running && state.transcode.status !== 'error' && state.transcode.status !== 'done');
      updateTranscode(state.transcode);
    }

    if (state.timeline) {
      lastTimeline = state.timeline;
      if (role === 'viewer' && player.readyState >= 1) applyTimeline(lastTimeline);
    }
  }

  function updateTranscode(transcode) {
    const value = transcode.progress || 0;
    $('transcodeProgress').style.width = `${value}%`;
    if (transcode.status === 'running') {
      $('transcodeStatus').textContent = `正在转码 ${value}%${transcode.speed ? ` · ${transcode.speed}` : ''}`;
    } else if (transcode.status === 'done') {
      $('transcodeStatus').textContent = 'iPhone 版本已就绪';
    } else if (transcode.status === 'error') {
      $('transcodeStatus').textContent = transcode.error || '转码失败';
      showToast(transcode.error || '转码失败');
    }
  }

  function timelineNow() {
    return { mediaTime: player.currentTime || 0, paused: player.paused, rate: player.playbackRate || 1 };
  }

  function sendTimeline() {
    if (role === 'host' && socket && socket.connected && !applyingRemote) socket.emit('timeline', timelineNow());
  }

  async function applyTimeline(timeline) {
    if (role !== 'viewer' || !timeline || !player.src) return;
    lastTimeline = timeline;
    const target = timeline.mediaTime + (timeline.paused ? 0 : (Date.now() - timeline.updatedAt) / 1000 * timeline.rate);
    applyingRemote = true;
    if (Math.abs((player.currentTime || 0) - target) > 0.65) player.currentTime = Math.max(0, target);
    player.playbackRate = timeline.rate || 1;
    if (timeline.paused) {
      player.pause();
    } else if (viewerUnlocked) {
      try { await player.play(); } catch { $('joinButton').classList.remove('hidden'); }
    } else {
      $('joinButton').classList.remove('hidden');
    }
    setTimeout(() => { applyingRemote = false; }, 80);
  }

  function connect() {
    socket = io({ auth: { roomToken, hostToken } });
    socket.on('connect', () => { $('roomRole').textContent = role === 'host' ? '主机放映中' : '已连接放映室'; });
    socket.on('connect_error', () => showToast('无法进入放映室，请确认链接是否完整。'));
    socket.on('state', render);
    socket.on('timeline', applyTimeline);
    socket.on('transcode', updateTranscode);
    socket.on('audience', (count) => { $('viewerCount').textContent = `${count || 0} 位观众`; });
  }

  async function bootstrap() {
    if (!routeToken) {
      location.href = '/';
      return;
    }

    if (role === 'host') {
      const response = await fetch('/api/state', { headers: { 'x-host-token': hostToken, 'x-room-token': '__discover__' } });
      if (response.status === 403) {
        const root = await fetch('/api/host-room', { headers: { 'x-host-token': hostToken } });
        if (!root.ok) throw new Error('主机链接无效。请重新启动服务并使用终端显示的新链接。');
        roomToken = (await root.json()).roomToken;
      }
    }

    const state = await api('/api/state');
    hostPanel.classList.toggle('hidden', role !== 'host');
    viewerNote.classList.toggle('hidden', role !== 'viewer');
    $('roomRole').textContent = role === 'host' ? '主机放映中' : '观众已入场';
    if (role === 'viewer') {
      $('headline').innerHTML = '今晚，我们在<br><em>同一段时间里。</em>';
      $('subhead').textContent = '播放进度由主机同步控制。戴上耳机，轻触播放器加入放映。';
    }
    render(state);
    if (role === 'host') $('shareLink').value = `${location.origin}/watch/${roomToken}`;
    connect();
  }

  player.addEventListener('play', sendTimeline);
  player.addEventListener('pause', sendTimeline);
  player.addEventListener('seeked', sendTimeline);
  player.addEventListener('ratechange', sendTimeline);
  player.addEventListener('loadedmetadata', () => {
    if (role === 'viewer' && lastTimeline) applyTimeline(lastTimeline);
  });
  setInterval(() => {
    if (role === 'host' && !player.paused) sendTimeline();
    if (role === 'viewer' && socket && socket.connected) socket.emit('request-sync');
  }, 2500);

  $('joinButton').addEventListener('click', async () => {
    viewerUnlocked = true;
    $('joinButton').classList.add('hidden');
    try {
      await player.play();
      if (lastTimeline) await applyTimeline(lastTimeline);
    } catch { showToast('Safari 阻止了播放，请再轻触一次播放器。'); }
  });

  $('movieInput').addEventListener('change', () => {
    const file = $('movieInput').files[0];
    if (!file) return;
    const form = new FormData();
    form.append('movie', file);
    const request = new XMLHttpRequest();
    request.open('POST', '/api/host/upload');
    request.setRequestHeader('x-host-token', hostToken);
    $('uploadProgressWrap').classList.remove('hidden');
    request.upload.onprogress = (event) => {
      const percent = event.lengthComputable ? Math.round(event.loaded / event.total * 100) : 0;
      $('uploadProgress').style.width = `${percent}%`;
      $('uploadStatus').textContent = `正在导入 ${percent}%`;
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        $('uploadStatus').textContent = '导入完成';
        showToast('电影已就绪。MKV 请继续点击“开始转码”。');
      } else {
        let message = '导入失败';
        try { message = JSON.parse(request.responseText).error || message; } catch {}
        showToast(message);
      }
    };
    request.onerror = () => showToast('导入中断，请检查主机服务。');
    request.send(form);
  });

  $('transcodeButton').addEventListener('click', async () => {
    try {
      await api('/api/host/transcode', { method: 'POST', body: JSON.stringify({ quality: $('quality').value }) });
      showToast('转码已开始。超清电影可能需要较长时间。');
    } catch (error) { showToast(error.message); }
  });

  $('cancelButton').addEventListener('click', async () => {
    try { await api('/api/host/transcode/cancel', { method: 'POST' }); } catch (error) { showToast(error.message); }
  });

  $('copyButton').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('shareLink').value);
      $('copyButton').textContent = '已复制';
      setTimeout(() => { $('copyButton').textContent = '复制'; }, 1600);
    } catch { $('shareLink').select(); document.execCommand('copy'); }
  });

  bootstrap().catch((error) => {
    $('roomRole').textContent = '连接失败';
    showToast(error.message);
  });
})();
