/* ============================================================
   🛴 КАТИМ В ШКОЛУ — Главный модуль приложения
   ============================================================ */

(function () {
  'use strict';

  /* ---------- СОСТОЯНИЕ ---------- */
  const S = {
    map: null,
    userPos: null,          // {lat, lng, heading, accuracy, speed}
    userMarker: null,
    accuracyCircle: null,
    watchId: null,
    route: null,            // текущий маршрут OSRM
    routeLine: null,        // L.polyline на карте
    routeCoords: [],        // [[lat,lng], ...]
    destMarker: null,
    destination: null,      // {lat, lng, name}
    navigating: false,
    navStepIdx: 0,
    navStartTime: null,
    navDistance: 0,
    lastWarnedMarkers: new Set(),
    lastSpokenStep: -1,
    placingMarker: null,    // тип метки при размещении
    markers: [],            // [{id,type,lat,lng,ts}, ...]
    mapMarkers: [],         // L.marker объекты
    places: [],
    trips: [],
    settings: {
      voice: true,
      vibration: true,
      profile: 'foot'      // foot | bike
    },
    activeTab: 'map',
    searchTimer: null,
    installPrompt: null
  };

  /* ---------- КОНСТАНТЫ ---------- */
  const MARKER_TYPES = {
    busy_road:       { emoji: '🚗', label: 'Оживлённая дорога', danger: true, voice: 'Впереди оживлённая дорога! Будьте осторожны!' },
    pothole:         { emoji: '🕳️', label: 'Ямы и выбоины',    danger: true, voice: 'Внимание, ямы на дороге!' },
    construction:    { emoji: '🚧', label: 'Ремонт дороги',     danger: true, voice: 'Впереди ремонт дороги!' },
    dogs:            { emoji: '🐕', label: 'Злые собаки',       danger: true, voice: 'Осторожно, собаки!' },
    poor_visibility: { emoji: '🌫️', label: 'Плохая видимость', danger: true, voice: 'Зона плохой видимости!' },
    steep:           { emoji: '⛰️', label: 'Крутой спуск',     danger: true, voice: 'Впереди крутой спуск! Притормозите!' },
    crossing:        { emoji: '🚶', label: 'Переход',           danger: true, voice: 'Пешеходный переход. Остановитесь и посмотрите по сторонам!' },
    good_surface:    { emoji: '✅', label: 'Хорошее покрытие',  danger: false, voice: 'Хорошее покрытие дороги.' },
    traffic_light:   { emoji: '🚦', label: 'Светофор',          danger: false, voice: 'Впереди светофор.' }
  };

  const MANEUVER_ICONS = {
    'depart': '🚀', 'arrive': '🏁',
    'turn-left': '⬅️', 'turn-right': '➡️',
    'sharp left': '↩️', 'sharp right': '↪️',
    'slight left': '↖️', 'slight right': '↗️',
    'straight': '⬆️', 'uturn': '🔄',
    'roundabout': '🔄', 'rotary': '🔄',
    'fork': '🔀', 'merge': '🔀',
    'end of road': '⬆️', 'new name': '⬆️',
    'default': '⬆️'
  };

  const WARN_RADIUS = 80;   // метры для предупреждения
  const OFF_ROUTE = 50;     // метры отклонения от маршрута
  const STEP_ANNOUNCE = 80; // метры до манёвра для объявления

  /* ==========================================================
     ИНИЦИАЛИЗАЦИЯ
     ========================================================== */
  function init() {
    loadData();
    initMap();
    initGeolocation();
    bindUI();
    registerSW();
    renderPlaces();
    renderStats();
    applySettings();
    generateAppIcons();

    // первый запуск
    if (!localStorage.getItem('katim_launched')) {
      localStorage.setItem('katim_launched', '1');
      setTimeout(() => toast('👋 Добро пожаловать! Укажите Дом и Школу в разделе «Места»'), 1000);
    }
  }

  /* ---------- Карта ---------- */
  function initMap() {
    S.map = L.map('map', {
      zoomControl: true,
      attributionControl: false
    }).setView([55.751, 37.618], 15);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(S.map);

    L.control.attribution({ position: 'bottomleft', prefix: false })
      .addAttribution('© <a href="https://osm.org">OSM</a>')
      .addTo(S.map);

    S.map.on('click', onMapClick);

    // загрузить метки на карту
    renderMapMarkers();
  }

  /* ---------- Геолокация ---------- */
  function initGeolocation() {
    if (!navigator.geolocation) {
      toast('⚠️ Геолокация недоступна');
      return;
    }
    S.watchId = navigator.geolocation.watchPosition(
      pos => onPosition(pos),
      err => console.warn('Geo error', err),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
    );
  }

  function onPosition(pos) {
    const { latitude: lat, longitude: lng, heading, accuracy, speed } = pos.coords;
    S.userPos = { lat, lng, heading, accuracy, speed: speed || 0 };

    // маркер пользователя
    if (!S.userMarker) {
      const icon = L.divIcon({
        className: '',
        html: '<div class="user-marker"></div>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      S.userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(S.map);
      S.map.setView([lat, lng], 16);
    } else {
      S.userMarker.setLatLng([lat, lng]);
    }

    // круг точности
    if (S.accuracyCircle) {
      S.accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
    } else {
      S.accuracyCircle = L.circle([lat, lng], {
        radius: accuracy,
        className: 'accuracy-circle',
        stroke: true,
        weight: 1,
        fillOpacity: 0.08
      }).addTo(S.map);
    }

    // навигация
    if (S.navigating) {
      updateNavigation();
    }
  }

  /* ==========================================================
     ПОИСК И МАРШРУТ
     ========================================================== */
  function searchAddress(query) {
    if (query.length < 3) { hideSearch(); return; }
    clearTimeout(S.searchTimer);
    S.searchTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&accept-language=ru&countrycodes=ru`;
        const res = await fetch(url, { headers: { 'User-Agent': 'KatimVShkolu/1.0' } });
        const data = await res.json();
        showSearchResults(data);
      } catch (e) {
        console.error('Search error', e);
      }
    }, 500);
  }

  function showSearchResults(items) {
    const el = document.getElementById('searchResults');
    if (!items.length) { hideSearch(); return; }

    // добавить сохранённые места в начало
    const savedHtml = S.places.filter(p => p.lat).map(p =>
      `<div class="sr-item" data-lat="${p.lat}" data-lng="${p.lng}" data-name="${p.name}">
        <span class="sr-icon">${p.icon}</span>
        <div><div class="sr-name">${p.name}</div><div class="sr-addr">Сохранённое место</div></div>
      </div>`
    ).join('');

    const searchHtml = items.map(i =>
      `<div class="sr-item" data-lat="${i.lat}" data-lng="${i.lon}" data-name="${i.display_name.split(',')[0]}">
        <span class="sr-icon">📍</span>
        <div><div class="sr-name">${i.display_name.split(',')[0]}</div>
        <div class="sr-addr">${i.display_name.split(',').slice(1, 3).join(',')}</div></div>
      </div>`
    ).join('');

    el.innerHTML = savedHtml + searchHtml;
    el.classList.remove('hidden');

    el.querySelectorAll('.sr-item').forEach(item => {
      item.addEventListener('click', () => {
        const lat = parseFloat(item.dataset.lat);
        const lng = parseFloat(item.dataset.lng);
        const name = item.dataset.name;
        selectDestination(lat, lng, name);
        hideSearch();
      });
    });
  }

  function hideSearch() {
    document.getElementById('searchResults').classList.add('hidden');
  }

  function selectDestination(lat, lng, name) {
    S.destination = { lat, lng, name };
    document.getElementById('searchInput').value = name;

    // маркер назначения
    if (S.destMarker) S.map.removeLayer(S.destMarker);
    S.destMarker = L.marker([lat, lng], {
      icon: L.divIcon({
        className: '',
        html: '<div class="dest-marker">🏫</div>',
        iconSize: [32, 32], iconAnchor: [16, 32]
      })
    }).addTo(S.map).bindPopup(`<b>${name}</b>`);

    if (S.userPos) {
      buildRoute(S.userPos.lat, S.userPos.lng, lat, lng);
    } else {
      toast('📍 Определяем местоположение...');
      S.map.setView([lat, lng], 15);
    }
  }

  /* ---------- OSRM маршрут ---------- */
  async function buildRoute(lat1, lng1, lat2, lng2) {
    try {
      toast('🔍 Строим маршрут...');
      const profile = S.settings.profile === 'bike' ? 'bike' : 'foot';
      const url = `https://router.project-osrm.org/route/v1/${profile}/${lng1},${lat1};${lng2},${lat2}?overview=full&geometries=geojson&steps=true&annotations=true`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.routes || !data.routes.length) {
        toast('❌ Маршрут не найден');
        return;
      }

      S.route = data.routes[0];
      S.routeCoords = S.route.geometry.coordinates.map(c => [c[1], c[0]]);

      // убрать старый маршрут
      if (S.routeLine) S.map.removeLayer(S.routeLine);

      // нарисовать маршрут
      S.routeLine = L.polyline(S.routeCoords, {
        color: '#1976D2',
        weight: 6,
        opacity: 0.8,
        lineJoin: 'round'
      }).addTo(S.map);

      S.map.fitBounds(S.routeLine.getBounds(), { padding: [50, 50] });

      showRouteSheet();
    } catch (e) {
      console.error('Route error', e);
      toast('❌ Ошибка построения маршрута');
    }
  }

  function showRouteSheet() {
    const r = S.route;
    const distKm = (r.distance / 1000).toFixed(1);
    const timeMin = Math.ceil(r.duration / 60);

    document.getElementById('rDist').textContent = distKm;
    document.getElementById('rTime').textContent = timeMin;

    // подсчёт опасных меток рядом с маршрутом
    let dangerCount = 0;
    S.markers.forEach(m => {
      const mt = MARKER_TYPES[m.type];
      if (mt && mt.danger) {
        const minD = minDistToRoute(m.lat, m.lng);
        if (minD < 100) dangerCount++;
      }
    });
    document.getElementById('rDangers').textContent = dangerCount;

    // шаги маршрута
    const stepsEl = document.getElementById('routeSteps');
    const steps = r.legs[0].steps;
    stepsEl.innerHTML = steps.map((s, i) => {
      const icon = getManeuverIcon(s.maneuver);
      const text = translateManeuver(s);
      const dist = s.distance > 0 ? formatDist(s.distance) : '';
      return `<div class="step-item">
        <span class="step-icon">${icon}</span>
        <span class="step-text">${text}</span>
        <span class="step-dist">${dist}</span>
      </div>`;
    }).join('');

    toggleSheet('routeSheet', true);
  }

  /* ==========================================================
     НАВИГАЦИЯ В РЕАЛЬНОМ ВРЕМЕНИ
     ========================================================== */
  function startNavigation() {
    if (!S.route || !S.userPos) {
      toast('⚠️ Нет маршрута или геолокации');
      return;
    }
    S.navigating = true;
    S.navStepIdx = 0;
    S.navStartTime = Date.now();
    S.navDistance = 0;
    S.lastSpokenStep = -1;
    S.lastWarnedMarkers.clear();

    document.body.classList.add('navigating');
    document.getElementById('navPanel').classList.remove('hidden');
    toggleSheet('routeSheet', false);

    speak('Маршрут начинается. Поехали!');
    updateNavigation();
  }

  function stopNavigation(completed) {
    S.navigating = false;
    document.body.classList.remove('navigating');
    document.getElementById('navPanel').classList.add('hidden');

    if (completed && S.navStartTime) {
      const trip = {
        id: Date.now(),
        date: new Date().toLocaleDateString('ru-RU'),
        from: 'Текущее место',
        to: S.destination ? S.destination.name : 'Назначение',
        distance: Math.round(S.route.distance),
        duration: Math.round((Date.now() - S.navStartTime) / 1000),
        profile: S.settings.profile
      };
      S.trips.unshift(trip);
      saveData();
      renderStats();
      speak('Вы прибыли! Отличная поездка!');
      toast('🏁 Поездка завершена и сохранена');
    } else {
      speak('Навигация остановлена.');
    }

    // очистить маршрут
    if (S.routeLine) { S.map.removeLayer(S.routeLine); S.routeLine = null; }
    if (S.destMarker) { S.map.removeLayer(S.destMarker); S.destMarker = null; }
    S.route = null;
    S.destination = null;
    document.getElementById('searchInput').value = '';
  }

  function updateNavigation() {
    if (!S.navigating || !S.userPos || !S.route) return;

    const pos = L.latLng(S.userPos.lat, S.userPos.lng);
    const steps = S.route.legs[0].steps;

    // следить за пользователем
    S.map.setView(pos, Math.max(S.map.getZoom(), 17));

    // найти ближайший шаг
    let minDist = Infinity;
    let closestStep = S.navStepIdx;

    for (let i = S.navStepIdx; i < steps.length; i++) {
      const sp = steps[i].maneuver.location;
      const d = pos.distanceTo(L.latLng(sp[1], sp[0]));
      if (d < minDist) { minDist = d; closestStep = i; }
    }

    // перешли к следующему шагу?
    if (closestStep > S.navStepIdx && minDist < 30) {
      S.navStepIdx = closestStep;
    }

    const currentStep = steps[Math.min(S.navStepIdx, steps.length - 1)];
    const nextStep = steps[Math.min(S.navStepIdx + 1, steps.length - 1)];

    // расстояние до следующего манёвра
    const nextLoc = nextStep.maneuver.location;
    const distToNext = pos.distanceTo(L.latLng(nextLoc[1], nextLoc[0]));

    // UI
    const icon = getManeuverIcon(nextStep.maneuver);
    const text = translateManeuver(nextStep);
    document.getElementById('navIcon').textContent = icon;
    document.getElementById('navText').textContent = text;
    document.getElementById('navDist').textContent = formatDist(distToNext);

    // ETA
    const remainDist = calcRemainingDistance(pos, S.navStepIdx);
    const speed = S.userPos.speed > 0.5 ? S.userPos.speed : 1.4; // м/с, ~5 км/ч по умолчанию
    const etaSec = remainDist / speed;
    const eta = new Date(Date.now() + etaSec * 1000);
    document.getElementById('navETA').textContent = eta.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    document.getElementById('navRemain').textContent = formatDist(remainDist);

    // голосовое объявление шага
    if (distToNext < STEP_ANNOUNCE && S.lastSpokenStep !== S.navStepIdx + 1) {
      S.lastSpokenStep = S.navStepIdx + 1;
      speak(`Через ${Math.round(distToNext)} метров ${text}`);
    }

    // проверка прибытия
    if (S.destination) {
      const distToDest = pos.distanceTo(L.latLng(S.destination.lat, S.destination.lng));
      if (distToDest < 30) {
        stopNavigation(true);
        return;
      }
    }

    // проверка отклонения от маршрута
    const distToRoute = minDistToRouteFromPos(pos);
    if (distToRoute > OFF_ROUTE) {
      speak('Вы отклонились от маршрута. Перестраиваем.');
      toast('🔄 Перестраиваем маршрут...');
      buildRoute(S.userPos.lat, S.userPos.lng, S.destination.lat, S.destination.lng).then(() => {
        if (S.route) {
          S.navStepIdx = 0;
          S.lastSpokenStep = -1;
        }
      });
    }

    // проверка опасных меток
    checkNearbyDangers(pos);
  }

  function calcRemainingDistance(pos, fromStepIdx) {
    const steps = S.route.legs[0].steps;
    let dist = 0;
    for (let i = fromStepIdx + 1; i < steps.length; i++) {
      dist += steps[i].distance;
    }
    // добавить расстояние до следующего шага
    if (fromStepIdx + 1 < steps.length) {
      const nextLoc = steps[fromStepIdx + 1].maneuver.location;
      dist += pos.distanceTo(L.latLng(nextLoc[1], nextLoc[0]));
    }
    return dist;
  }

  function minDistToRouteFromPos(pos) {
    let min = Infinity;
    for (let i = 0; i < S.routeCoords.length; i++) {
      const d = pos.distanceTo(L.latLng(S.routeCoords[i]));
      if (d < min) min = d;
    }
    return min;
  }

  function minDistToRoute(lat, lng) {
    if (!S.routeCoords.length) return Infinity;
    const p = L.latLng(lat, lng);
    let min = Infinity;
    for (const c of S.routeCoords) {
      const d = p.distanceTo(L.latLng(c));
      if (d < min) min = d;
    }
    return min;
  }

  /* ==========================================================
     МЕТКИ
     ========================================================== */
  function startPlacingMarker(type) {
    S.placingMarker = type;
    document.body.classList.add('placing-marker');
    toggleSheet('markerSheet', false);
    toast(`Нажмите на карту для установки метки "${MARKER_TYPES[type].label}"`);
  }

  function onMapClick(e) {
    if (S.placingMarker) {
      addMarker(S.placingMarker, e.latlng.lat, e.latlng.lng);
      S.placingMarker = null;
      document.body.classList.remove('placing-marker');
      return;
    }

    // если выбираем место на карте для сохранения
    if (S._pickingPlaceOnMap) {
      S._pickedCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
      document.getElementById('placeCoordInfo').textContent =
        `📍 ${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`;
      document.getElementById('savePlaceBtn').disabled = false;
      S._pickingPlaceOnMap = false;
      document.getElementById('placeModal').classList.remove('hidden');
      toast('✅ Место выбрано');
      return;
    }
  }

  function addMarker(type, lat, lng) {
    const marker = {
      id: Date.now(),
      type,
      lat,
      lng,
      ts: new Date().toISOString()
    };
    S.markers.push(marker);
    saveData();
    addMarkerToMap(marker);
    toast(`✅ Метка "${MARKER_TYPES[type].label}" добавлена`);
  }

  function addMarkerToMap(m) {
    const mt = MARKER_TYPES[m.type];
    if (!mt) return;

    const icon = L.divIcon({
      className: '',
      html: `<div class="marker-emoji">${mt.emoji}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    });

    const marker = L.marker([m.lat, m.lng], { icon })
      .addTo(S.map)
      .bindPopup(`
        <b>${mt.emoji} ${mt.label}</b><br>
        <small>${new Date(m.ts).toLocaleDateString('ru-RU')}</small><br>
        <button onclick="window._deleteMarker(${m.id})" style="margin-top:8px;padding:4px 12px;background:#ffebee;color:#D32F2F;border:none;border-radius:8px;cursor:pointer;">Удалить</button>
      `);

    S.mapMarkers.push({ id: m.id, leaflet: marker });
  }

  window._deleteMarker = function (id) {
    S.markers = S.markers.filter(m => m.id !== id);
    const idx = S.mapMarkers.findIndex(m => m.id === id);
    if (idx >= 0) {
      S.map.removeLayer(S.mapMarkers[idx].leaflet);
      S.mapMarkers.splice(idx, 1);
    }
    saveData();
    toast('🗑️ Метка удалена');
  };

  function renderMapMarkers() {
    // очистить
    S.mapMarkers.forEach(m => S.map.removeLayer(m.leaflet));
    S.mapMarkers = [];
    S.markers.forEach(m => addMarkerToMap(m));
  }

  function checkNearbyDangers(pos) {
    S.markers.forEach(m => {
      const mt = MARKER_TYPES[m.type];
      if (!mt) return;

      const dist = pos.distanceTo(L.latLng(m.lat, m.lng));
      if (dist < WARN_RADIUS && !S.lastWarnedMarkers.has(m.id)) {
        S.lastWarnedMarkers.add(m.id);

        if (mt.danger) {
          speak(mt.voice);
          vibrate([200, 100, 200, 100, 300]);
          toast(`⚠️ ${mt.label} рядом!`);
        } else {
          speak(mt.voice);
        }

        // сбросить предупреждение через 60 сек
        setTimeout(() => S.lastWarnedMarkers.delete(m.id), 60000);
      }
    });
  }

  /* ==========================================================
     ГОЛОС И ВИБРАЦИЯ
     ========================================================== */
  function speak(text) {
    if (!S.settings.voice) return;
    if (!window.speechSynthesis) return;

    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;

    // выбрать русский голос если есть
    const voices = window.speechSynthesis.getVoices();
    const ruVoice = voices.find(v => v.lang.startsWith('ru'));
    if (ruVoice) u.voice = ruVoice;

    window.speechSynthesis.speak(u);
  }

  // подгрузить голоса
  if (window.speechSynthesis) {
    speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
  }

  function vibrate(pattern) {
    if (!S.settings.vibration) return;
    if (navigator.vibrate) navigator.vibrate(pattern);
  }

  /* ==========================================================
     МАНЁВРЫ
     ========================================================== */
  function getManeuverIcon(maneuver) {
    const key = maneuver.modifier
      ? `${maneuver.type}-${maneuver.modifier}`.replace('turn-', '')
      : maneuver.type;

    // попробовать найти точное совпадение
    if (MANEUVER_ICONS[key]) return MANEUVER_ICONS[key];
    if (MANEUVER_ICONS[maneuver.modifier]) return MANEUVER_ICONS[maneuver.modifier];
    if (MANEUVER_ICONS[maneuver.type]) return MANEUVER_ICONS[maneuver.type];

    // по модификатору
    if (maneuver.modifier) {
      if (maneuver.modifier.includes('left')) return '⬅️';
      if (maneuver.modifier.includes('right')) return '➡️';
      if (maneuver.modifier === 'straight') return '⬆️';
      if (maneuver.modifier === 'uturn') return '🔄';
    }

    return MANEUVER_ICONS['default'];
  }

  function translateManeuver(step) {
    const m = step.maneuver;
    const name = step.name || '';
    const ref = step.ref || '';
    const road = name || ref || 'дорогу';

    const modifiers = {
      'uturn': 'Развернитесь',
      'sharp right': 'Резко поверните направо',
      'right': 'Поверните направо',
      'slight right': 'Плавно поверните направо',
      'straight': 'Продолжайте прямо',
      'slight left': 'Плавно поверните налево',
      'left': 'Поверните налево',
      'sharp left': 'Резко поверните налево'
    };

    switch (m.type) {
      case 'depart':
        return `Начните движение по ${road}`;
      case 'arrive':
        return 'Вы прибыли к месту назначения!';
      case 'turn':
      case 'end of road':
      case 'fork':
        return `${modifiers[m.modifier] || 'Поверните'} на ${road}`;
      case 'new name':
      case 'merge':
        return `Продолжайте по ${road}`;
      case 'roundabout':
      case 'rotary':
        return `На кольце ${m.exit ? `${m.exit}-й съезд` : ''} на ${road}`;
      default:
        return modifiers[m.modifier] || `Продолжайте по ${road}`;
    }
  }

  /* ==========================================================
     МЕСТА
     ========================================================== */
  function renderPlaces() {
    const el = document.getElementById('placesList');

    if (!S.places.length) {
      // создать дефолтные
      S.places = [
        { id: 1, name: 'Дом', icon: '🏠', lat: null, lng: null },
        { id: 2, name: 'Школа', icon: '🏫', lat: null, lng: null }
      ];
      saveData();
    }

    el.innerHTML = S.places.map(p => `
      <div class="place-card" data-id="${p.id}">
        <span class="p-icon">${p.icon}</span>
        <div class="p-info">
          <div class="p-name">${p.name}</div>
          <div class="p-addr">${p.lat ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}` : 'Не указано'}</div>
        </div>
        <div class="p-actions">
          ${p.lat ? `<button class="p-btn" onclick="window._routeToPlace(${p.id})" title="Маршрут">🛴</button>` : ''}
          <button class="p-btn" onclick="window._editPlace(${p.id})" title="Изменить">✏️</button>
          ${p.id > 2 ? `<button class="p-btn p-del" onclick="window._deletePlace(${p.id})" title="Удалить">🗑️</button>` : ''}
        </div>
      </div>
    `).join('');
  }

  window._routeToPlace = function (id) {
    const p = S.places.find(x => x.id === id);
    if (!p || !p.lat) return;
    switchTab('map');
    selectDestination(p.lat, p.lng, p.name);
  };

  window._editPlace = function (id) {
    const p = S.places.find(x => x.id === id);
    if (!p) return;
    openPlaceModal(p);
  };

  window._deletePlace = function (id) {
    if (!confirm('Удалить это место?')) return;
    S.places = S.places.filter(p => p.id !== id);
    saveData();
    renderPlaces();
    toast('🗑️ Место удалено');
  };

  function openPlaceModal(existing) {
    const modal = document.getElementById('placeModal');
    const nameInput = document.getElementById('placeNameInput');
    const iconSelect = document.getElementById('placeIconSelect');
    const coordInfo = document.getElementById('placeCoordInfo');

    S._editingPlace = existing || null;
    S._pickedCoords = existing && existing.lat ? { lat: existing.lat, lng: existing.lng } : null;

    nameInput.value = existing ? existing.name : '';
    iconSelect.value = existing ? existing.icon : '🏫';
    coordInfo.textContent = S._pickedCoords
      ? `📍 ${S._pickedCoords.lat.toFixed(5)}, ${S._pickedCoords.lng.toFixed(5)}`
      : '';
    document.getElementById('savePlaceBtn').disabled = !S._pickedCoords;

    modal.classList.remove('hidden');
  }

  function savePlaceFromModal() {
    const name = document.getElementById('placeNameInput').value.trim();
    const icon = document.getElementById('placeIconSelect').value;
    if (!name || !S._pickedCoords) return;

    if (S._editingPlace) {
      const p = S.places.find(x => x.id === S._editingPlace.id);
      if (p) {
        p.name = name;
        p.icon = icon;
        p.lat = S._pickedCoords.lat;
        p.lng = S._pickedCoords.lng;
      }
    } else {
      S.places.push({
        id: Date.now(),
        name, icon,
        lat: S._pickedCoords.lat,
        lng: S._pickedCoords.lng
      });
    }

    saveData();
    renderPlaces();
    document.getElementById('placeModal').classList.add('hidden');
    toast('✅ Место сохранено');
  }

  /* ==========================================================
     СТАТИСТИКА
     ========================================================== */
  function renderStats() {
    const summary = document.getElementById('statsSummary');
    const list = document.getElementById('tripsList');

    const totalTrips = S.trips.length;
    const totalDist = S.trips.reduce((s, t) => s + (t.distance || 0), 0);
    const totalTime = S.trips.reduce((s, t) => s + (t.duration || 0), 0);
    const avgSpeed = totalTime > 0 ? (totalDist / totalTime * 3.6) : 0;

    summary.innerHTML = `
      <div class="stat-card"><span class="s-val">${totalTrips}</span><span class="s-lbl">Поездок</span></div>
      <div class="stat-card"><span class="s-val">${(totalDist / 1000).toFixed(1)}</span><span class="s-lbl">Всего км</span></div>
      <div class="stat-card"><span class="s-val">${Math.round(totalTime / 60)}</span><span class="s-lbl">Минут в пути</span></div>
      <div class="stat-card"><span class="s-val">${avgSpeed.toFixed(1)}</span><span class="s-lbl">Сред. км/ч</span></div>
    `;

    if (!S.trips.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--text2);padding:20px;">Пока нет поездок 🛴</p>';
      return;
    }

    list.innerHTML = S.trips.slice(0, 50).map(t => `
      <div class="trip-item">
        <span class="t-icon">${t.profile === 'bike' ? '🚲' : '🛴'}</span>
        <div class="t-info">
          <div class="t-route">${t.from} → ${t.to}</div>
          <div class="t-meta">${t.date} · ${formatDist(t.distance)} · ${Math.round(t.duration / 60)} мин</div>
        </div>
      </div>
    `).join('');
  }

  /* ==========================================================
     НАСТРОЙКИ И ДАННЫЕ
     ========================================================== */
  function loadData() {
    try {
      S.markers = JSON.parse(localStorage.getItem('katim_markers')) || [];
      S.places = JSON.parse(localStorage.getItem('katim_places')) || [];
      S.trips = JSON.parse(localStorage.getItem('katim_trips')) || [];
      S.settings = {
        ...S.settings,
        ...JSON.parse(localStorage.getItem('katim_settings') || '{}')
      };
    } catch (e) {
      console.error('Load data error', e);
    }
  }

  function saveData() {
    try {
      localStorage.setItem('katim_markers', JSON.stringify(S.markers));
      localStorage.setItem('katim_places', JSON.stringify(S.places));
      localStorage.setItem('katim_trips', JSON.stringify(S.trips));
      localStorage.setItem('katim_settings', JSON.stringify(S.settings));
    } catch (e) {
      console.error('Save data error', e);
    }
  }

  function applySettings() {
    document.getElementById('setVoice').checked = S.settings.voice;
    document.getElementById('setVibro').checked = S.settings.vibration;
    document.getElementById('setProfile').value = S.settings.profile;
    updateProfileButton();
  }

  function updateProfileButton() {
    const btn = document.getElementById('profileToggle');
    btn.textContent = S.settings.profile === 'bike' ? '🚲' : '🛴';
  }

  function exportData() {
    const data = {
      version: 1,
      markers: S.markers,
      places: S.places,
      trips: S.trips,
      settings: S.settings,
      exported: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `katim-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast('📤 Данные экспортированы');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        if (data.markers) S.markers = data.markers;
        if (data.places) S.places = data.places;
        if (data.trips) S.trips = data.trips;
        if (data.settings) S.settings = { ...S.settings, ...data.settings };
        saveData();
        renderMapMarkers();
        renderPlaces();
        renderStats();
        applySettings();
        toast('📥 Данные импортированы');
      } catch (err) {
        toast('❌ Ошибка при импорте файла');
      }
    };
    reader.readAsText(file);
  }

  /* ==========================================================
     ИНТЕРФЕЙС
     ========================================================== */
  function bindUI() {
    // поиск
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearch');
    input.addEventListener('input', (e) => {
      const v = e.target.value.trim();
      clearBtn.classList.toggle('hidden', !v);
      searchAddress(v);
    });
    input.addEventListener('focus', () => {
      if (S.places.filter(p => p.lat).length) {
        showSearchResults([]); // показать сохранённые места
      }
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      clearBtn.classList.add('hidden');
      hideSearch();
    });

    // профиль
    document.getElementById('profileToggle').addEventListener('click', () => {
      S.settings.profile = S.settings.profile === 'foot' ? 'bike' : 'foot';
      updateProfileButton();
      saveData();
      toast(`Маршрут: ${S.settings.profile === 'bike' ? '🚲 Велосипедный' : '🛴 Самокатный'}`);
      // перестроить маршрут если есть
      if (S.destination && S.userPos) {
        buildRoute(S.userPos.lat, S.userPos.lng, S.destination.lat, S.destination.lng);
      }
    });

    // вкладки
    document.querySelectorAll('#bottomNav .tab').forEach(tab => {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // FAB
    document.getElementById('fabLocate').addEventListener('click', () => {
      if (S.userPos) {
        S.map.setView([S.userPos.lat, S.userPos.lng], 17);
      } else {
        toast('📍 Определяем местоположение...');
      }
    });

    document.getElementById('fabMarker').addEventListener('click', () => {
      toggleSheet('markerSheet', true);
    });

    // выбор типа метки
    document.querySelectorAll('.mk-btn').forEach(btn => {
      btn.addEventListener('click', () => startPlacingMarker(btn.dataset.type));
    });
    document.getElementById('cancelMk').addEventListener('click', () => {
      S.placingMarker = null;
      document.body.classList.remove('placing-marker');
      toggleSheet('markerSheet', false);
    });

    // маршрут
    document.getElementById('goBtn').addEventListener('click', startNavigation);
    document.getElementById('closeRoute').addEventListener('click', () => {
      toggleSheet('routeSheet', false);
      if (S.routeLine) { S.map.removeLayer(S.routeLine); S.routeLine = null; }
      if (S.destMarker) { S.map.removeLayer(S.destMarker); S.destMarker = null; }
      S.route = null;
      S.destination = null;
      document.getElementById('searchInput').value = '';
    });

    // навигация
    document.getElementById('stopNavBtn').addEventListener('click', () => stopNavigation(false));

    // места
    document.getElementById('addPlaceBtn').addEventListener('click', () => openPlaceModal(null));
    document.getElementById('placeHere').addEventListener('click', () => {
      if (S.userPos) {
        S._pickedCoords = { lat: S.userPos.lat, lng: S.userPos.lng };
        document.getElementById('placeCoordInfo').textContent =
          `📍 ${S.userPos.lat.toFixed(5)}, ${S.userPos.lng.toFixed(5)}`;
        document.getElementById('savePlaceBtn').disabled = false;
      } else {
        toast('📍 Геолокация недоступна');
      }
    });
    document.getElementById('placeOnMap').addEventListener('click', () => {
      S._pickingPlaceOnMap = true;
      document.getElementById('placeModal').classList.add('hidden');
      switchTab('map');
      toast('Нажмите на карту для выбора места');
    });
    document.getElementById('savePlaceBtn').addEventListener('click', savePlaceFromModal);
    document.getElementById('cancelPlaceBtn').addEventListener('click', () => {
      document.getElementById('placeModal').classList.add('hidden');
    });

    // настройки
    document.getElementById('setVoice').addEventListener('change', (e) => {
      S.settings.voice = e.target.checked;
      saveData();
    });
    document.getElementById('setVibro').addEventListener('change', (e) => {
      S.settings.vibration = e.target.checked;
      saveData();
    });
    document.getElementById('setProfile').addEventListener('change', (e) => {
      S.settings.profile = e.target.value;
      updateProfileButton();
      saveData();
    });
    document.getElementById('exportBtn').addEventListener('click', exportData);
    document.getElementById('importBtn').addEventListener('click', () => {
      document.getElementById('importFile').click();
    });
    document.getElementById('importFile').addEventListener('change', (e) => {
      if (e.target.files.length) importData(e.target.files[0]);
    });
    document.getElementById('clearBtn').addEventListener('click', () => {
      if (confirm('Очистить все данные? Это действие нельзя отменить.')) {
        S.markers = []; S.places = []; S.trips = [];
        saveData();
        renderMapMarkers();
        renderPlaces();
        renderStats();
        toast('🗑️ Все данные удалены');
      }
    });

    // PWA install
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      S.installPrompt = e;
      document.getElementById('installBanner').classList.remove('hidden');
    });
    document.getElementById('installBtn').addEventListener('click', async () => {
      if (S.installPrompt) {
        S.installPrompt.prompt();
        const result = await S.installPrompt.userChoice;
        if (result.outcome === 'accepted') toast('✅ Приложение установлено!');
        S.installPrompt = null;
        document.getElementById('installBanner').classList.add('hidden');
      }
    });
    document.getElementById('dismissInstall').addEventListener('click', () => {
      document.getElementById('installBanner').classList.add('hidden');
    });
  }

  function switchTab(tab) {
    S.activeTab = tab;

    // вкладки
    document.querySelectorAll('#bottomNav .tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });

    // панели
    ['placesPanel', 'statsPanel', 'settingsPanel'].forEach(id => {
      document.getElementById(id).classList.add('hidden');
    });

    // FAB и карту показываем только на вкладке карты
    document.getElementById('fabs').style.display = tab === 'map' ? 'flex' : 'none';

    switch (tab) {
      case 'map':
        setTimeout(() => S.map.invalidateSize(), 50);
        break;
      case 'places':
        document.getElementById('placesPanel').classList.remove('hidden');
        renderPlaces();
        break;
      case 'stats':
        document.getElementById('statsPanel').classList.remove('hidden');
        renderStats();
        break;
      case 'settings':
        document.getElementById('settingsPanel').classList.remove('hidden');
        break;
    }
  }

  function toggleSheet(id, show) {
    const el = document.getElementById(id);
    if (show) {
      // закрыть другие шиты
      document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('show'), 3000);
  }

  /* ==========================================================
     УТИЛИТЫ
     ========================================================== */
  function formatDist(meters) {
    if (meters >= 1000) return (meters / 1000).toFixed(1) + ' км';
    return Math.round(meters) + ' м';
  }

  /* ==========================================================
     PWA
     ========================================================== */
  function registerSW() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(() => console.log('SW registered'))
        .catch(err => console.warn('SW error', err));
    }
  }

  /* ==========================================================
     ГЕНЕРАЦИЯ ИКОНОК (для PWA, если файлов нет)
     ========================================================== */
  function generateAppIcons() {
    // Создаём favicon динамически
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');

    // фон
    ctx.fillStyle = '#2E7D32';
    ctx.beginPath();
    ctx.roundRect(0, 0, 64, 64, 12);
    ctx.fill();

    // текст
    ctx.font = '36px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛴', 32, 34);

    // установить favicon
    const link = document.querySelector("link[rel*='icon']") || document.createElement('link');
    link.type = 'image/png';
    link.rel = 'icon';
    link.href = canvas.toDataURL();
    document.head.appendChild(link);

    // также apple-touch-icon
    generateAndSaveIcon(192, 'icon-192.png');
    generateAndSaveIcon(512, 'icon-512.png');
  }

  function generateAndSaveIcon(size, filename) {
    // генерируем для кеширования через SW
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');

    const r = size * 0.15;
    ctx.fillStyle = '#2E7D32';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, r);
    ctx.fill();

    // белый круг
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.45, size * 0.3, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = `${size * 0.5}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛴', size * 0.5, size * 0.5);

    ctx.fillStyle = 'white';
    ctx.font = `bold ${size * 0.09}px -apple-system, sans-serif`;
    ctx.fillText('КАТИМ!', size * 0.5, size * 0.88);
  }

  /* ==========================================================
     СТАРТ
     ========================================================== */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }


})();
