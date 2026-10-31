/* App de marcación: todo se guarda primero en el celular y luego se envía a Google Sheets. */
(function () {
  'use strict';

  var API = (window.CONFIG || {}).apiUrl || '';
  var ZONA = 'America/Bogota';
  var ITERACIONES_PIN = 100000;
  var ESPERA_RED_MS = 45000;
  var CADA_SINCRONIZACION_MS = 60000;

  var $ = function (id) { return document.getElementById(id); };
  var PANTALLAS = ['pSinConfig', 'pVincular', 'pAutorizar', 'pPin', 'pMarcar', 'pListo'];

  var perfil = null;
  var turno = null;
  var obras = [];
  var turnoMaximo = 18;
  var marca = { gps: null, gpsFallo: false, foto: null };
  var sincronizando = false;
  var ultimaMarcaId = null;

  /* ---------- Almacenamiento local ---------- */

  var conexionDb = null;

  function abrirDb() {
    if (conexionDb) return Promise.resolve(conexionDb);
    return new Promise(function (ok, mal) {
      var r = indexedDB.open('control-horario', 1);
      r.onupgradeneeded = function () {
        r.result.createObjectStore('cola', { keyPath: 'id' });
        r.result.createObjectStore('kv');
      };
      r.onsuccess = function () { conexionDb = r.result; ok(conexionDb); };
      r.onerror = function () { mal(r.error); };
    });
  }

  function operar(almacen, modo, fn) {
    return abrirDb().then(function (db) {
      return new Promise(function (ok, mal) {
        var t = db.transaction(almacen, modo);
        var pedido = fn(t.objectStore(almacen));
        t.oncomplete = function () { ok(pedido.result); };
        t.onerror = t.onabort = function () { mal(t.error); };
      });
    });
  }

  function leer(clave) { return operar('kv', 'readonly', function (s) { return s.get(clave); }); }
  function guardar(clave, valor) { return operar('kv', 'readwrite', function (s) { return s.put(valor, clave); }); }
  function colaTodas() {
    return operar('cola', 'readonly', function (s) { return s.getAll(); }).then(function (filas) {
      return filas.sort(function (a, b) { return a.marcaMs - b.marcaMs; });
    });
  }
  function colaGuardar(m) { return operar('cola', 'readwrite', function (s) { return s.put(m); }); }
  function colaQuitar(id) { return operar('cola', 'readwrite', function (s) { return s.delete(id); }); }

  /* ---------- Servicio ---------- */

  function llamar(accion, datos) {
    var control = new AbortController();
    var espera = setTimeout(function () { control.abort(); }, ESPERA_RED_MS);
    return fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ accion: accion }, datos)),
      redirect: 'follow',
      signal: control.signal
    }).then(function (r) { return r.json(); }).then(function (r) {
      clearTimeout(espera);
      if (!r.ok) {
        var e = new Error(r.error);
        e.delServicio = true;
        throw e;
      }
      return r.datos;
    }, function (e) {
      clearTimeout(espera);
      throw e;
    });
  }

  function credenciales() {
    return { cedula: perfil.cedula, token: perfil.token };
  }

  function aplicarEstado(r) {
    obras = r.obras;
    turno = r.turno;
    turnoMaximo = r.turnoMaximo;
    perfil.nombre = r.nombre;
    perfil.empresa = r.empresa;
    perfil.autorizado = r.autorizado;
    $('empresa').textContent = r.empresa;
    return Promise.all([guardar('perfil', perfil), guardar('obras', obras), guardar('turno', turno), guardar('turnoMaximo', turnoMaximo)]);
  }

  function celularDesvinculado() {
    perfil.token = null;
    return guardar('perfil', perfil).then(function () {
      $('cedula').value = perfil.cedula;
      error('eVincular', 'Este celular quedó desvinculado. Tus marcaciones guardadas siguen aquí: vincúlalo de nuevo con internet.');
      mostrar('pVincular');
    });
  }

  /* ---------- Sincronización ---------- */

  function sincronizar() {
    if (sincronizando || !perfil || !perfil.token) return Promise.resolve();
    sincronizando = true;
    return colaTodas().then(function enviar(pendientes) {
      if (!pendientes.length) return null;
      var m = pendientes[0];
      return llamar('registrar', Object.assign({}, m, credenciales(), { relojMs: Date.now() })).then(function () {
        return colaQuitar(m.id);
      }).then(function () {
        pintarCola();
        if (m.id === ultimaMarcaId) pintarEnvio(true);
        return enviar(pendientes.slice(1));
      }, function (e) {
        if (!e.delServicio) throw e;
        if (e.message === 'NO_VINCULADO') throw e;
        m.error = e.message;
        return colaGuardar(m).then(function () { throw e; });
      });
    }).then(function () {
      return llamar('estado', credenciales());
    }).then(function (r) {
      return colaTodas().then(function (filas) { return filas.length ? null : aplicarEstado(r); });
    }).catch(function (e) {
      if (e.message === 'NO_VINCULADO') return celularDesvinculado();
    }).then(function () {
      sincronizando = false;
      pintarCola();
    });
  }

  function pintarCola() {
    if (!perfil) return Promise.resolve();
    return colaTodas().then(function (filas) {
      var con = navigator.onLine;
      var fallo = filas.filter(function (m) { return m.error; })[0];
      $('banda').hidden = con;
      $('banda').textContent = 'Sin conexión. Puedes marcar normalmente.';
      $('pCola').hidden = !perfil.token;
      $('bEnviar').hidden = !filas.length || !con;
      $('estadoCola').className = 'estado ' + (fallo ? 'mal' : filas.length ? '' : 'ok');
      $('estadoCola').textContent = fallo ? 'No se pudo enviar: ' + fallo.error :
        filas.length ? filas.length + (filas.length === 1 ? ' marcación guardada' : ' marcaciones guardadas') + ' en este celular. Se envían al tener señal.' :
          'Todo enviado';
    });
  }

  /* ---------- Vistas ---------- */

  function mostrar(id) {
    PANTALLAS.forEach(function (p) { $(p).hidden = p !== id; });
    window.scrollTo(0, 0);
  }

  function error(id, texto) {
    $(id).textContent = texto || '';
    $(id).hidden = !texto;
  }

  function horaTexto(ms) {
    return new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(ms));
  }

  function fechaHoraTexto(ms) {
    return new Intl.DateTimeFormat('es-CO', { timeZone: ZONA, dateStyle: 'short', timeStyle: 'short', hour12: true }).format(new Date(ms));
  }

  function primerNombre() {
    return perfil.nombre.split(' ')[0];
  }

  function nuevoId() {
    return Date.now().toString(36) + '-' + crypto.getRandomValues(new Uint32Array(2)).join('-');
  }

  /* ---------- PIN local ---------- */

  function aHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function huellaPin(pin, sal) {
    var codigo = new TextEncoder();
    return crypto.subtle.importKey('raw', codigo.encode(pin), 'PBKDF2', false, ['deriveBits']).then(function (clave) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: codigo.encode(sal), iterations: ITERACIONES_PIN }, clave, 256);
    }).then(aHex);
  }

  /* ---------- Flujo ---------- */

  function siguientePantalla() {
    if (!perfil || !perfil.token) return mostrar('pVincular');
    if (!perfil.autorizado) return mostrar('pAutorizar');
    $('saludoPin').textContent = 'Hola, ' + primerNombre();
    $('pin').value = '';
    error('ePin', '');
    mostrar('pPin');
  }

  $('fVincular').addEventListener('submit', function (ev) {
    ev.preventDefault();
    error('eVincular', '');
    var cedula = $('cedula').value.trim();
    var pin = $('pinNuevo').value.trim();
    $('bVincular').disabled = true;
    colaTodas().then(function (filas) {
      if (filas.length && perfil && perfil.cedula !== cedula) {
        throw new Error('Este celular tiene marcaciones pendientes de otra persona.');
      }
      return llamar('vincular', { cedula: cedula, pin: pin });
    }).then(function (r) {
      var sal = crypto.getRandomValues(new Uint32Array(4)).join('-');
      return huellaPin(pin, sal).then(function (huella) {
        perfil = { cedula: cedula, token: r.token, sal: sal, huella: huella };
        return aplicarEstado(r);
      });
    }).then(function () {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      $('pinNuevo').value = '';
      $('bVincular').disabled = false;
      pintarCola();
      siguientePantalla();
      sincronizar();
    }, function (e) {
      $('bVincular').disabled = false;
      error('eVincular', e.delServicio || /pendientes/.test(e.message) ? e.message : 'Necesitas internet para vincular el celular.');
    });
  });

  $('bAcepto').addEventListener('click', function () {
    $('bAcepto').disabled = true;
    error('eAutorizar', '');
    llamar('autorizar', credenciales()).then(function () {
      perfil.autorizado = true;
      return guardar('perfil', perfil);
    }).then(function () {
      $('bAcepto').disabled = false;
      siguientePantalla();
    }, function (e) {
      $('bAcepto').disabled = false;
      error('eAutorizar', e.delServicio ? e.message : 'Necesitas internet para este paso.');
    });
  });

  $('fPin').addEventListener('submit', function (ev) {
    ev.preventDefault();
    $('bPin').disabled = true;
    huellaPin($('pin').value.trim(), perfil.sal).then(function (huella) {
      $('bPin').disabled = false;
      if (huella !== perfil.huella) return error('ePin', 'PIN incorrecto.');
      abrirMarcacion();
    });
  });

  function turnoVigente() {
    return turno && Date.now() - turno.desdeMs <= turnoMaximo * 3600 * 1000 ? turno : null;
  }

  function abrirMarcacion() {
    var abierto = turnoVigente();
    marca = { gps: null, gpsFallo: false, foto: null };
    $('saludo').textContent = 'Hola, ' + primerNombre();
    $('estadoTurno').textContent = abierto ? 'Turno abierto en ' + abierto.obra + ' desde las ' + horaTexto(abierto.desdeMs) : 'No tienes un turno abierto';
    $('bloqueObra').hidden = !!abierto;
    var sel = $('obra');
    sel.textContent = '';
    sel.add(new Option('Selecciona…', ''));
    obras.forEach(function (o) { sel.add(new Option(o, o)); });
    $('observaciones').value = '';
    $('foto').value = '';
    $('vistaFoto').hidden = true;
    $('bFoto').textContent = 'Tomar foto';
    pintarFoto('Pendiente', '');
    $('bMarcar').textContent = abierto ? 'Registrar SALIDA' : 'Registrar ENTRADA';
    $('bMarcar').classList.toggle('salida', !!abierto);
    error('eMarcar', '');
    tic();
    mostrar('pMarcar');
    pedirGps();
    validar();
  }

  function tic() {
    $('reloj').textContent = horaTexto(Date.now());
  }

  function pintarGps(texto, clase) {
    $('estadoGps').textContent = texto;
    $('estadoGps').className = 'estado ' + clase;
  }

  function pintarFoto(texto, clase) {
    $('estadoFoto').textContent = texto;
    $('estadoFoto').className = 'estado ' + clase;
  }

  function pedirGps() {
    $('bGps').hidden = true;
    pintarGps('Buscando señal GPS…', '');
    var fallo = function () {
      marca.gpsFallo = true;
      $('bGps').hidden = false;
      pintarGps('No disponible. Sal a cielo abierto y reintenta. Si marcas así quedará una alerta.', 'mal');
      validar();
    };
    if (!navigator.geolocation) return fallo();
    navigator.geolocation.getCurrentPosition(function (p) {
      marca.gps = { lat: p.coords.latitude, lng: p.coords.longitude, precision: p.coords.accuracy, gpsMs: p.timestamp };
      marca.gpsFallo = false;
      pintarGps('Ubicación lista (±' + Math.round(p.coords.accuracy) + ' m)', 'ok');
      validar();
    }, fallo, { enableHighAccuracy: true, timeout: 45000, maximumAge: 60000 });
  }
  $('bGps').addEventListener('click', pedirGps);

  $('bFoto').addEventListener('click', function () { $('foto').click(); });
  $('foto').addEventListener('change', function () {
    var archivo = this.files[0];
    if (!archivo) return;
    pintarFoto('Procesando…', '');
    var url = URL.createObjectURL(archivo);
    var img = new Image();
    img.onload = function () {
      var escala = Math.min(1, 720 / Math.max(img.width, img.height));
      var lienzo = document.createElement('canvas');
      lienzo.width = Math.round(img.width * escala);
      lienzo.height = Math.round(img.height * escala);
      lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
      marca.foto = lienzo.toDataURL('image/jpeg', 0.7);
      URL.revokeObjectURL(url);
      $('vistaFoto').src = marca.foto;
      $('vistaFoto').hidden = false;
      $('bFoto').textContent = 'Repetir';
      pintarFoto('Foto lista', 'ok');
      validar();
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      pintarFoto('No se pudo leer la foto. Intenta otra vez.', 'mal');
    };
    img.src = url;
  });

  $('obra').addEventListener('change', validar);

  function validar() {
    var obraLista = !!turnoVigente() || !!$('obra').value;
    $('bMarcar').disabled = !obraLista || !(marca.gps || marca.gpsFallo) || !marca.foto;
  }

  $('bMarcar').addEventListener('click', function () {
    error('eMarcar', '');
    $('bMarcar').disabled = true;
    var abierto = turnoVigente();
    var gps = marca.gps || {};
    var ahora = Date.now();
    var obra = abierto ? abierto.obra : $('obra').value;
    var m = {
      id: nuevoId(), tipo: abierto ? 'SALIDA' : 'ENTRADA', marcaMs: ahora, obra: obra,
      lat: gps.lat, lng: gps.lng, precision: gps.precision, gpsMs: gps.gpsMs,
      foto: marca.foto, observaciones: $('observaciones').value
    };
    colaGuardar(m).then(function () {
      turno = abierto ? null : { desdeMs: ahora, obra: obra };
      return guardar('turno', turno);
    }).then(function () {
      ultimaMarcaId = m.id;
      $('listoTitulo').textContent = m.tipo === 'ENTRADA' ? 'Entrada guardada' : 'Salida guardada';
      $('listoHora').textContent = fechaHoraTexto(ahora);
      var horas = abierto ? Math.round((ahora - abierto.desdeMs) / 36000) / 100 : null;
      $('listoDetalle').textContent = obra + (horas !== null ? ' · ' + horas + ' h de turno' : '');
      pintarEnvio(false);
      mostrar('pListo');
      pintarCola();
      sincronizar();
    }, function () {
      validar();
      error('eMarcar', 'No se pudo guardar en el celular. Intenta otra vez.');
    });
  });

  function pintarEnvio(enviada) {
    $('listoEnvio').textContent = enviada ? 'Enviada a la oficina' : 'Se enviará cuando haya señal';
    $('listoEnvio').className = 'estado ' + (enviada ? 'ok' : '');
  }

  function cerrar() {
    siguientePantalla();
  }
  $('bFin').addEventListener('click', cerrar);
  $('bSalir').addEventListener('click', cerrar);
  $('bEnviar').addEventListener('click', function () { sincronizar(); });

  window.addEventListener('online', function () { pintarCola(); sincronizar(); });
  window.addEventListener('offline', pintarCola);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) sincronizar();
  });
  setInterval(tic, 20000);
  setInterval(sincronizar, CADA_SINCRONIZACION_MS);

  if (!window.Capacitor && 'serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js');
  }

  if (!API) {
    mostrar('pSinConfig');
    return;
  }

  Promise.all([leer('perfil'), leer('obras'), leer('turno'), leer('turnoMaximo')]).then(function (v) {
    perfil = v[0] || null;
    obras = v[1] || [];
    turno = v[2] || null;
    turnoMaximo = v[3] || turnoMaximo;
    if (perfil) $('empresa').textContent = perfil.empresa;
    siguientePantalla();
    pintarCola();
    sincronizar();
  });
})();
