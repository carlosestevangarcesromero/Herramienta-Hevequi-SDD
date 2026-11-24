'use strict';
/* =========================================================
   Control de bodega Hevequi — app.js

   Bloques:
   1. Configuración (URL y clave pública de Supabase)
   2. Generador de QR (código propio, sin librería)
   3. Utilidades (textos, fechas, mensajes)
   4. Sesión: ingreso con Google y perfil
   5. Navegación por rol
   6. Cámara (lector de QR del navegador)
   7. Órdenes de compra
   8. QR de la orden e impresión
   9. Recepción (FL-04 y FL-07)
   10. Validación municipal (FL-05 y FL-08)
   11. Salida (VALIDADO → ENTREGADO)
   12. Tablero, cuadre y exportación (FL-06 y FL-09)
   13. Historial del ítem
   14. Usuarios y auditoría (FL-10)
   15. Arranque

   Las reglas de negocio viven en la base de datos (schema.sql).
   Esta página solo muestra y llama a esas reglas: si alguien
   modifica la página, la base igual rechaza lo que no se permite.
   ========================================================= */


/* ---------- 1. Configuración ----------
   Copia estos dos datos de Supabase > Project Settings > API.
   La clave "publishable" (o "anon") es pública y puede ir aquí.
   NUNCA pongas aquí la clave "secret" ni "service_role". */
const SUPABASE_URL = 'https://icaqcpvdzruzqhkbwyrd.supabase.co';
const SUPABASE_CLAVE_PUBLICA = 'sb_publishable_kr_vzPgVsmT2jdijP1N8vA_ti0YnumP';

const configurado = !SUPABASE_URL.includes('TU-PROYECTO') && !SUPABASE_CLAVE_PUBLICA.startsWith('TU_');
const bd = configurado ? supabase.createClient(SUPABASE_URL, SUPABASE_CLAVE_PUBLICA) : null;


/* ---------- 2. Generador de QR ----------
   Tomado del generador propio de Estevan (herramienta-qr/seguimiento/qr.js).
   QR.crear(texto) → matriz · QR.verificar(matriz, texto) · QR.svg(matriz) */
/* =========================================================
   Seguimiento Hevequi — generador de códigos QR

   Es el mismo generador de la v1 (ya retirada), con
   corrección de errores nivel Q (~25 %): la etiqueta sigue
   leyéndose aunque se raye o se arrugue un poco.
   Norma ISO/IEC 18004, modo byte (UTF-8), versiones 1 a 40.
   Basado en el algoritmo de referencia de Project Nayuki.

   Uso: QR.crear(texto) → matriz; QR.verificar(matriz, texto)
   relee la matriz y confirma que dice lo mismo; QR.svg(matriz)
   devuelve la imagen.
   ========================================================= */

const QR = (function () {
  // Tablas de la norma para el nivel Q, por versión (índice 0 sin uso)
  const ECC_POR_BLOQUE = [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
  const NUM_BLOQUES = [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68];
  const BITS_NIVEL = 3;   // nivel Q en la información de formato

  // ---- Aritmética de Reed-Solomon (campo GF(256)) ----
  function multiplicar(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function divisorRS(grado) {
    const resultado = new Array(grado - 1).fill(0);
    resultado.push(1);
    let raiz = 1;
    for (let i = 0; i < grado; i++) {
      for (let j = 0; j < resultado.length; j++) {
        resultado[j] = multiplicar(resultado[j], raiz);
        if (j + 1 < resultado.length) resultado[j] ^= resultado[j + 1];
      }
      raiz = multiplicar(raiz, 0x02);
    }
    return resultado;
  }

  function restoRS(datos, divisor) {
    const resultado = divisor.map(() => 0);
    for (const b of datos) {
      const factor = b ^ resultado.shift();
      resultado.push(0);
      divisor.forEach((coef, i) => { resultado[i] ^= multiplicar(coef, factor); });
    }
    return resultado;
  }

  // ---- Capacidades por versión ----
  function modulosDeDatos(version) {
    let resultado = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const numAlineacion = Math.floor(version / 7) + 2;
      resultado -= (25 * numAlineacion - 10) * numAlineacion - 55;
      if (version >= 7) resultado -= 36;
    }
    return resultado;
  }

  function codewordsDeDatos(version) {
    return Math.floor(modulosDeDatos(version) / 8) - ECC_POR_BLOQUE[version] * NUM_BLOQUES[version];
  }

  function posicionesAlineacion(version, tam) {
    if (version === 1) return [];
    const cantidad = Math.floor(version / 7) + 2;
    const paso = Math.floor((version * 8 + cantidad * 3 + 5) / (cantidad * 4 - 4)) * 2;
    const resultado = [6];
    for (let pos = tam - 7; resultado.length < cantidad; pos -= paso) resultado.splice(1, 0, pos);
    return resultado;
  }

  // ---- Dibujo de la matriz ----
  function ponerFijo(m, x, y, oscuro) {
    m.modulos[y * m.tam + x] = oscuro ? 1 : 0;
    m.funcion[y * m.tam + x] = 1;
  }

  function dibujarPatrones(m) {
    const tam = m.tam;
    // Líneas de sincronización
    for (let i = 0; i < tam; i++) {
      ponerFijo(m, 6, i, i % 2 === 0);
      ponerFijo(m, i, 6, i % 2 === 0);
    }
    // Tres cuadros de posición (esquinas)
    for (const [cx, cy] of [[3, 3], [tam - 4, 3], [3, tam - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < tam && y >= 0 && y < tam) ponerFijo(m, x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    // Patrones de alineación
    const pos = posicionesAlineacion(m.version, tam);
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            ponerFijo(m, pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
          }
        }
      }
    }
    dibujarFormato(m, 0); // se reserva el espacio; se rellena al elegir máscara
    dibujarVersion(m);
  }

  function dibujarFormato(m, mascara) {
    const datos = (BITS_NIVEL << 3) | mascara;
    let resto = datos;
    for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
    const bits = ((datos << 10) | resto) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) === 1;
    const tam = m.tam;

    for (let i = 0; i <= 5; i++) ponerFijo(m, 8, i, bit(i));
    ponerFijo(m, 8, 7, bit(6));
    ponerFijo(m, 8, 8, bit(7));
    ponerFijo(m, 7, 8, bit(8));
    for (let i = 9; i < 15; i++) ponerFijo(m, 14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) ponerFijo(m, tam - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) ponerFijo(m, 8, tam - 15 + i, bit(i));
    ponerFijo(m, 8, tam - 8, true);
  }

  function dibujarVersion(m) {
    if (m.version < 7) return;
    let resto = m.version;
    for (let i = 0; i < 12; i++) resto = (resto << 1) ^ ((resto >>> 11) * 0x1F25);
    const bits = (m.version << 12) | resto;
    for (let i = 0; i < 18; i++) {
      const oscuro = ((bits >>> i) & 1) === 1;
      const a = m.tam - 11 + (i % 3);
      const b = Math.floor(i / 3);
      ponerFijo(m, a, b, oscuro);
      ponerFijo(m, b, a, oscuro);
    }
  }

  // Recorre la matriz en zigzag (de derecha a izquierda, de a dos columnas)
  function recorrerZigzag(m, visitar) {
    const tam = m.tam;
    for (let derecha = tam - 1; derecha >= 1; derecha -= 2) {
      if (derecha === 6) derecha = 5;
      for (let vert = 0; vert < tam; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = derecha - j;
          const haciaArriba = ((derecha + 1) & 2) === 0;
          const y = haciaArriba ? tam - 1 - vert : vert;
          const k = y * tam + x;
          if (!m.funcion[k]) visitar(k);
        }
      }
    }
  }

  function dibujarDatos(m, codewords) {
    let i = 0;
    recorrerZigzag(m, (k) => {
      if (i < codewords.length * 8) {
        m.modulos[k] = (codewords[i >>> 3] >>> (7 - (i & 7))) & 1;
        i++;
      }
    });
  }

  function condicionMascara(mascara, x, y) {
    switch (mascara) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function aplicarMascara(modulos, funcion, tam, mascara) {
    for (let y = 0; y < tam; y++) {
      for (let x = 0; x < tam; x++) {
        const k = y * tam + x;
        if (!funcion[k] && condicionMascara(mascara, x, y)) modulos[k] ^= 1;
      }
    }
  }

  // Puntaje de la norma: menor puntaje = QR más fácil de leer
  function penalizacion(m) {
    const tam = m.tam;
    const mod = m.modulos;
    let puntos = 0;
    let oscuros = 0;
    const patronA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const patronB = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

    for (let dir = 0; dir < 2; dir++) {
      for (let a = 0; a < tam; a++) {
        const linea = new Array(tam);
        for (let b = 0; b < tam; b++) linea[b] = dir === 0 ? mod[a * tam + b] : mod[b * tam + a];
        // Regla 1: cinco o más módulos seguidos del mismo color
        let racha = 1;
        for (let b = 1; b <= tam; b++) {
          if (b < tam && linea[b] === linea[b - 1]) {
            racha++;
          } else {
            if (racha >= 5) puntos += racha - 2;
            racha = 1;
          }
        }
        // Regla 3: patrones parecidos a los cuadros de posición
        for (let b = 0; b + 11 <= tam; b++) {
          let igualA = true;
          let igualB = true;
          for (let c = 0; c < 11; c++) {
            if (linea[b + c] !== patronA[c]) igualA = false;
            if (linea[b + c] !== patronB[c]) igualB = false;
          }
          if (igualA) puntos += 40;
          if (igualB) puntos += 40;
        }
      }
    }
    // Regla 2: bloques de 2x2 del mismo color
    for (let y = 0; y < tam - 1; y++) {
      for (let x = 0; x < tam - 1; x++) {
        const v = mod[y * tam + x];
        if (v === mod[y * tam + x + 1] && v === mod[(y + 1) * tam + x] && v === mod[(y + 1) * tam + x + 1]) puntos += 3;
      }
    }
    // Regla 4: proporción de módulos oscuros
    for (let k = 0; k < mod.length; k++) oscuros += mod[k];
    const total = tam * tam;
    const desvio = Math.ceil(Math.abs(oscuros * 20 - total * 10) / total) - 1;
    puntos += Math.max(0, desvio) * 10;
    return puntos;
  }

  // Divide los datos en bloques, añade la corrección de errores e intercala
  function datosConCorreccion(datos, version) {
    const numBloques = NUM_BLOQUES[version];
    const largoECC = ECC_POR_BLOQUE[version];
    const totalCodewords = Math.floor(modulosDeDatos(version) / 8);
    const bloquesCortos = numBloques - (totalCodewords % numBloques);
    const largoCorto = Math.floor(totalCodewords / numBloques);
    const divisor = divisorRS(largoECC);

    const bloques = [];
    for (let i = 0, k = 0; i < numBloques; i++) {
      const parte = datos.slice(k, k + largoCorto - largoECC + (i < bloquesCortos ? 0 : 1));
      k += parte.length;
      const ecc = restoRS(parte, divisor);
      if (i < bloquesCortos) parte.push(0);
      bloques.push(parte.concat(ecc));
    }

    const resultado = [];
    for (let i = 0; i < bloques[0].length; i++) {
      bloques.forEach((bloque, j) => {
        if (i !== largoCorto - largoECC || j >= bloquesCortos) resultado.push(bloque[i]);
      });
    }
    return resultado;
  }

  // ---- Función principal: texto → matriz QR ----
  function crear(texto) {
    const bytes = new TextEncoder().encode(texto);

    let version = 0;
    for (let v = 1; v <= 40; v++) {
      const bitsConteo = v <= 9 ? 8 : 16;
      if (4 + bitsConteo + bytes.length * 8 <= codewordsDeDatos(v) * 8) { version = v; break; }
    }
    if (!version) {
      throw new Error(`el texto ocupa ${bytes.length} bytes y no cabe en un QR de nivel Q.`);
    }

    // Secuencia de bits: modo byte (0100) + cantidad + datos + relleno
    const bits = [];
    const agregar = (valor, cantidad) => { for (let i = cantidad - 1; i >= 0; i--) bits.push((valor >>> i) & 1); };
    agregar(0b0100, 4);
    agregar(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) agregar(b, 8);
    const capacidad = codewordsDeDatos(version) * 8;
    agregar(0, Math.min(4, capacidad - bits.length));
    agregar(0, (8 - (bits.length % 8)) % 8);
    for (let relleno = 0xEC; bits.length < capacidad; relleno ^= 0xEC ^ 0x11) agregar(relleno, 8);

    const datos = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
      datos.push(byte);
    }

    const tam = version * 4 + 17;
    const m = { version, tam, mascara: 0, modulos: new Uint8Array(tam * tam), funcion: new Uint8Array(tam * tam) };
    dibujarPatrones(m);
    dibujarDatos(m, datosConCorreccion(datos, version));

    // Se prueban las 8 máscaras y se queda la de menor penalización
    let mejor = 0;
    let menor = Infinity;
    for (let mascara = 0; mascara < 8; mascara++) {
      aplicarMascara(m.modulos, m.funcion, tam, mascara);
      dibujarFormato(m, mascara);
      const puntos = penalizacion(m);
      if (puntos < menor) { menor = puntos; mejor = mascara; }
      aplicarMascara(m.modulos, m.funcion, tam, mascara); // deshace
    }
    aplicarMascara(m.modulos, m.funcion, tam, mejor);
    dibujarFormato(m, mejor);
    m.mascara = mejor;
    return m;
  }

  // ---- Verificación: lee el QR ya dibujado y compara con el texto original ----
  function verificar(m, texto) {
    const version = m.version;
    const modulos = m.modulos.slice();
    aplicarMascara(modulos, m.funcion, m.tam, m.mascara); // quita la máscara

    const total = Math.floor(modulosDeDatos(version) / 8);
    const leidos = new Array(total).fill(0);
    let i = 0;
    recorrerZigzag(m, (k) => {
      if (i < total * 8) {
        leidos[i >>> 3] |= modulos[k] << (7 - (i & 7));
        i++;
      }
    });

    // Reconstruye los bloques y comprueba su corrección de errores
    const numBloques = NUM_BLOQUES[version];
    const largoECC = ECC_POR_BLOQUE[version];
    const bloquesCortos = numBloques - (total % numBloques);
    const largoCorto = Math.floor(total / numBloques);
    const bloques = Array.from({ length: numBloques }, () => []);
    let p = 0;
    for (let a = 0; a <= largoCorto; a++) {
      for (let j = 0; j < numBloques; j++) {
        if (a === largoCorto - largoECC && j < bloquesCortos) continue;
        bloques[j].push(leidos[p++]);
      }
    }
    const divisor = divisorRS(largoECC);
    const datos = [];
    for (const bloque of bloques) {
      const parteDatos = bloque.slice(0, bloque.length - largoECC);
      const parteECC = bloque.slice(bloque.length - largoECC);
      const esperado = restoRS(parteDatos, divisor);
      if (esperado.some((v, k) => v !== parteECC[k])) return false;
      datos.push(...parteDatos);
    }

    // Lee el modo, la cantidad y los bytes
    let posBit = 0;
    const leerBits = (n) => {
      let valor = 0;
      for (let k = 0; k < n; k++, posBit++) valor = (valor << 1) | ((datos[posBit >>> 3] >>> (7 - (posBit & 7))) & 1);
      return valor;
    };
    if (leerBits(4) !== 0b0100) return false;
    const cantidad = leerBits(version <= 9 ? 8 : 16);
    const esperado = new TextEncoder().encode(texto);
    if (cantidad !== esperado.length) return false;
    for (let k = 0; k < cantidad; k++) {
      if (leerBits(8) !== esperado[k]) return false;
    }
    return true;
  }

  // Dibuja la matriz como SVG (con 4 módulos de margen blanco, como pide la norma)
  function svg(m) {
    const borde = 4;
    const lado = m.tam + borde * 2;
    let ruta = '';
    for (let y = 0; y < m.tam; y++) {
      for (let x = 0; x < m.tam; x++) {
        if (m.modulos[y * m.tam + x]) ruta += `M${x + borde},${y + borde}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges">` +
      `<rect width="${lado}" height="${lado}" fill="#fff"/><path d="${ruta}" fill="#000"/></svg>`;
  }

  return { crear, verificar, svg };
})();


/* ---------- 3. Utilidades ---------- */
const $ = (id) => document.getElementById(id);

// Nombres de los estados como se muestran en pantalla
const NOMBRE_ESTADO = {
  GENERADO: 'GENERADO', EN_VALIDACION: 'EN VALIDACIÓN', VALIDADO: 'VALIDADO',
  PNC: 'PNC', DEVOLUCION: 'DEVOLUCIÓN', ENTREGADO: 'ENTREGADO'
};
const NOMBRE_ROL = { coordinador: 'Coordinador', supervisor: 'Supervisor', auxiliar: 'Auxiliar', comprador: 'Comprador' };

// Evita que un texto de la base se interprete como HTML
function esc(valor) {
  return String(valor ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function etiquetaEstado(estado) {
  return `<span class="estado estado-${esc(estado)}">${esc(NOMBRE_ESTADO[estado] || estado)}</span>`;
}

// Fecha y hora en Bogotá
function fechaHora(valor) {
  if (!valor) return '';
  return new Date(valor).toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });
}

function hoy() {
  // Fecha de hoy en Bogotá, formato AAAA-MM-DD
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// Franja grande de resultado: tipo 'ok' o 'error'
function franja(tipo, titulo, detalle) {
  const f = $('franja');
  f.className = 'franja ' + tipo;
  f.innerHTML = esc(titulo) + (detalle ? `<small>${esc(detalle)}</small>` : '');
  f.hidden = false;
  f.scrollIntoView({ block: 'nearest' });
}
function ocultarFranja() { $('franja').hidden = true; }

// Traduce los errores de Supabase a un mensaje claro
function mensajeError(error) {
  const texto = error?.message || String(error);
  if (/row-level security/i.test(texto)) return 'No tienes permiso para esta acción.';
  if (/duplicate key.*numero_oc/i.test(texto)) return 'Ya existe una orden con ese número.';
  if (/duplicate key.*correo/i.test(texto)) return 'Ya existe un usuario con ese correo.';
  if (/duplicate key/i.test(texto)) return 'Ese registro ya existe.';
  if (/Failed to fetch|NetworkError/i.test(texto)) return 'Sin conexión. Revisa el internet y vuelve a intentar.';
  return texto;
}
function mostrarError(error) { franja('error', mensajeError(error)); }

// Opciones de un <select>
function llenarSelect(select, filas, valor, texto, primera) {
  select.innerHTML = (primera ? `<option value="">${esc(primera)}</option>` : '') +
    filas.map((f) => `<option value="${esc(f[valor])}">${esc(f[texto])}</option>`).join('');
}

// Trae todas las filas de una consulta, de 1.000 en 1.000 (límite de Supabase)
async function traerTodo(crearConsulta) {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await crearConsulta().range(desde, desde + 999);
    if (error) throw error;
    filas.push(...data);
    if (data.length < 1000) return filas;
  }
}

// Datos compartidos que se cargan una vez
const datos = { perfil: null, municipios: [], proveedores: [], misMunicipios: [], transiciones: [] };


/* ---------- 4. Sesión ---------- */
async function iniciarSesion() {
  if (!configurado) {
    mensajeIngreso('Falta configurar Supabase: escribe la URL y la clave pública al inicio de app.js.');
    return;
  }
  const { error } = await bd.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname }
  });
  if (error) mensajeIngreso(mensajeError(error));
}

function mensajeIngreso(texto) {
  const m = $('ingreso-mensaje');
  m.textContent = texto;
  m.hidden = !texto;
}

async function cerrarSesion() {
  apagarCamara();
  if (bd) await bd.auth.signOut();
  datos.perfil = null;
  $('app').hidden = true;
  $('pantalla-ingreso').hidden = false;
}

// Se llama cuando hay sesión de Google: busca el perfil en la tabla usuarios
async function cargarPerfil() {
  const { data, error } = await bd.rpc('registrar_ingreso');
  if (error || !data?.length) {
    await bd.auth.signOut();
    mensajeIngreso(error ? mensajeError(error) : 'Tu correo no está autorizado. Pide acceso al Coordinador.');
    return;
  }
  datos.perfil = data[0];
  $('usuario-nombre').textContent = datos.perfil.nombre;
  $('usuario-rol').textContent = NOMBRE_ROL[datos.perfil.rol];

  await cargarCatalogos();
  $('pantalla-ingreso').hidden = true;
  $('app').hidden = false;
  armarMenu();
}

async function cargarCatalogos() {
  const [mun, prov, trans, mios] = await Promise.all([
    bd.from('municipios').select('id, nombre').eq('activo', true).order('nombre'),
    bd.from('proveedores').select('id, nombre').eq('activo', true).order('nombre'),
    bd.from('transiciones').select('*').eq('rol', datos.perfil.rol),
    bd.from('usuario_municipio').select('municipio_id').eq('usuario_id', datos.perfil.id)
  ]);
  const error = mun.error || prov.error || trans.error || mios.error;
  if (error) { mostrarError(error); return; }
  datos.municipios = mun.data;
  datos.proveedores = prov.data;
  datos.transiciones = trans.data;
  datos.misMunicipios = mios.data.map((m) => m.municipio_id);
}


/* ---------- 5. Navegación por rol ---------- */
const alAbrirVista = {}; // cada bloque registra qué hacer al abrir su vista

function armarMenu() {
  const rol = datos.perfil.rol;
  let primera = null;
  document.querySelectorAll('#menu [data-vista]').forEach((boton) => {
    const permitido = boton.dataset.roles.split(' ').includes(rol);
    boton.hidden = !permitido;
    if (permitido && !primera) primera = boton.dataset.vista;
  });
  // Oculta los grupos sin opciones para este rol
  document.querySelectorAll('.grupo-menu').forEach((g) => {
    g.hidden = !g.querySelector('[data-vista]:not([hidden])');
  });
  cambiarVista(primera);
}

function cambiarVista(nombre) {
  apagarCamara();
  ocultarFranja();
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.id !== 'vista-' + nombre; });
  document.querySelectorAll('#menu [data-vista]').forEach((b) => {
    b.classList.toggle('activo', b.dataset.vista === nombre);
    if (b.dataset.vista === nombre) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  abrirMenu(false);
  if (alAbrirVista[nombre]) alAbrirVista[nombre]();
}

function abrirMenu(abrir) {
  $('menu').classList.toggle('abierto', abrir);
  $('btn-menu').setAttribute('aria-expanded', String(abrir));
}


/* ---------- 6. Cámara ----------
   Usa BarcodeDetector, que trae Chrome en Android. Si el navegador
   no lo tiene, se escribe el código a mano (o con pistola lectora). */
let camara = { flujo: null, video: null, activa: false };

async function encenderCamara(video, alLeer) {
  if (!('BarcodeDetector' in window)) {
    franja('error', 'Este navegador no lee QR con la cámara.', 'Escribe el código en el campo de abajo, o usa Chrome en Android.');
    return;
  }
  apagarCamara();
  try {
    const detector = new BarcodeDetector({ formats: ['qr_code'] });
    camara.flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    camara.video = video;
    camara.activa = true;
    video.srcObject = camara.flujo;
    video.hidden = false;
    await video.play();

    // Busca un QR cada 300 ms hasta encontrarlo
    const buscar = async () => {
      if (!camara.activa) return;
      try {
        const codigos = await detector.detect(video);
        if (codigos.length) {
          apagarCamara();
          alLeer(codigos[0].rawValue);
          return;
        }
      } catch (e) { /* cuadro sin imagen todavía: se reintenta */ }
      setTimeout(buscar, 300);
    };
    buscar();
  } catch (e) {
    apagarCamara();
    franja('error', 'No se pudo abrir la cámara.', 'Da permiso de cámara al navegador o escribe el código.');
  }
}

function apagarCamara() {
  camara.activa = false;
  if (camara.flujo) camara.flujo.getTracks().forEach((t) => t.stop());
  if (camara.video) { camara.video.hidden = true; camara.video.srcObject = null; }
  camara.flujo = null;
}


/* ---------- 7. Órdenes de compra (FL-03) ---------- */
function filaItemOrden() {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="it-producto" required maxlength="200" aria-label="Producto"></td>
    <td><input class="it-descripcion" maxlength="300" aria-label="Descripción"></td>
    <td><select class="it-municipio" required aria-label="Municipio"></select></td>
    <td><input class="it-beneficiario" maxlength="200" aria-label="Beneficiario"></td>
    <td><button type="button" class="btn btn-chico it-quitar">Quitar</button></td>`;
  llenarSelect(tr.querySelector('.it-municipio'), datos.municipios, 'id', 'nombre', 'Elige municipio');
  tr.querySelector('.it-quitar').onclick = () => tr.remove();
  $('oc-items').appendChild(tr);
}

alAbrirVista.ordenes = async () => {
  llenarSelect($('oc-proveedor'), datos.proveedores, 'id', 'nombre', 'Elige proveedor');
  $('oc-fecha').value = hoy();
  if (!$('oc-items').children.length) filaItemOrden();
  await listarOrdenes();
};

async function listarOrdenes() {
  const { data, error } = await bd.from('ordenes_compra')
    .select('id, numero_oc, fecha, proveedores(nombre), usuarios(nombre), items(count)')
    .order('creado_en', { ascending: false }).limit(200);
  if (error) return mostrarError(error);
  $('lista-ordenes').innerHTML = data.length ? data.map((o) => `
    <tr><td class="cod">${esc(o.numero_oc)}</td><td>${esc(o.proveedores?.nombre)}</td>
    <td>${esc(o.fecha)}</td><td class="num">${o.items?.[0]?.count ?? 0}</td><td>${esc(o.usuarios?.nombre)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="vacio"><strong>No hay órdenes.</strong> Crea la primera con el formulario de arriba.</td></tr>';
}

async function agregarProveedor() {
  const nombre = $('prov-nombre').value.trim();
  if (!nombre) return franja('error', 'Escribe el nombre del proveedor.');
  const { data, error } = await bd.from('proveedores').insert({ nombre }).select('id, nombre').single();
  if (error) return mostrarError(error);
  datos.proveedores.push(data);
  datos.proveedores.sort((a, b) => a.nombre.localeCompare(b.nombre));
  llenarSelect($('oc-proveedor'), datos.proveedores, 'id', 'nombre', 'Elige proveedor');
  $('oc-proveedor').value = data.id;
  $('prov-nombre').value = '';
  franja('ok', 'Proveedor agregado: ' + data.nombre);
}

async function guardarOrden(evento) {
  evento.preventDefault();
  const filas = [...$('oc-items').querySelectorAll('tr')];
  const items = filas.map((tr) => ({
    producto: tr.querySelector('.it-producto').value.trim(),
    descripcion: tr.querySelector('.it-descripcion').value.trim() || null,
    municipio_id: Number(tr.querySelector('.it-municipio').value),
    beneficiario: tr.querySelector('.it-beneficiario').value.trim() || null
  }));
  // FL-03: ¿Datos completos?
  if (!items.length) return franja('error', 'Agrega al menos un ítem a la orden.');
  if (items.some((i) => !i.producto || !i.municipio_id)) {
    return franja('error', 'Faltan datos en los ítems.', 'Cada ítem necesita producto y municipio.');
  }

  const { data: orden, error } = await bd.from('ordenes_compra').insert({
    numero_oc: $('oc-numero').value.trim(),
    proveedor_id: Number($('oc-proveedor').value),
    fecha: $('oc-fecha').value,
    comprador_id: datos.perfil.id
  }).select('id, numero_oc').single();
  if (error) return mostrarError(error);

  const { error: errorItems } = await bd.from('items').insert(items.map((i) => ({ ...i, orden_id: orden.id })));
  if (errorItems) {
    return franja('error', 'La orden ' + orden.numero_oc + ' se creó, pero sus ítems no.', mensajeError(errorItems));
  }

  franja('ok', `Orden ${orden.numero_oc} guardada con ${items.length} ítems.`, 'Ve a "QR de la orden" para imprimir sus QR.');
  $('form-orden').reset();
  $('oc-fecha').value = hoy();
  $('oc-items').innerHTML = '';
  filaItemOrden();
  listarOrdenes();
}


/* ---------- 8. QR de la orden ---------- */
alAbrirVista.qr = async () => {
  const { data, error } = await bd.from('ordenes_compra').select('id, numero_oc')
    .order('creado_en', { ascending: false }).limit(500);
  if (error) return mostrarError(error);
  llenarSelect($('qr-orden'), data, 'id', 'numero_oc', 'Elige una orden');
  $('hoja-etiquetas').innerHTML = '';
  $('qr-resumen').textContent = '';
  $('btn-imprimir-qr').disabled = true;
};

async function mostrarEtiquetas() {
  const ordenId = $('qr-orden').value;
  $('hoja-etiquetas').innerHTML = '';
  $('btn-imprimir-qr').disabled = true;
  if (!ordenId) return;

  const { data, error } = await bd.from('vista_items')
    .select('codigo_qr, producto, municipio, numero_oc, estado_actual')
    .eq('orden_id', ordenId).order('id');
  if (error) return mostrarError(error);

  const errores = [];
  $('hoja-etiquetas').innerHTML = data.map((i) => {
    const matriz = QR.crear(i.codigo_qr);
    if (!QR.verificar(matriz, i.codigo_qr)) errores.push(i.codigo_qr); // se relee antes de imprimir
    return `<div class="etiqueta">${QR.svg(matriz)}
      <div><strong>${esc(i.codigo_qr)}</strong>${esc(i.producto)}<br>${esc(i.municipio)}<br>OC ${esc(i.numero_oc)}</div></div>`;
  }).join('');

  if (errores.length) {
    franja('error', 'Algunos QR no se pudieron verificar: ' + errores.join(', '), 'No los imprimas y avisa al Coordinador.');
    return;
  }
  $('qr-resumen').textContent = `${data.length} QR listos para imprimir (etiqueta de 50 x 25 mm).`;
  $('btn-imprimir-qr').disabled = data.length === 0;
}

function imprimirQR() {
  document.body.classList.add('imprimiendo-qr');
  window.print();
  document.body.classList.remove('imprimiendo-qr');
}


/* ---------- 9. Recepción (FL-04 y FL-07) ---------- */
let itemRecepcion = null;

alAbrirVista.recepcion = () => {
  itemRecepcion = null;
  $('rec-detalle').hidden = true;
  $('rec-codigo').focus();
};

async function validarRecepcion(codigo) {
  codigo = String(codigo || '').trim();
  $('rec-detalle').hidden = true;
  itemRecepcion = null;
  if (!codigo) return franja('error', 'Escribe o escanea un código.');

  const { data, error } = await bd.rpc('validar_qr_recepcion', {
    p_codigo: codigo, p_numero_oc: $('rec-oc').value.trim() || null
  });
  if (error) return mostrarError(error);

  if (!data.ok) {
    let detalle = 'La incidencia quedó registrada.';
    if (data.tipo === 'ya_recibido') detalle = `Lo recibió ${data.recibido_por || '—'} el ${fechaHora(data.recibido_en)}. ` + detalle;
    return franja('error', data.mensaje, detalle);
  }

  itemRecepcion = data.item;
  const municipio = datos.municipios.find((m) => m.id === data.item.municipio_id)?.nombre;
  $('rec-datos').innerHTML = `
    <dt>Código</dt><dd class="codigo">${esc(data.item.codigo_qr)}</dd>
    <dt>Producto</dt><dd>${esc(data.item.producto)}</dd>
    <dt>Descripción</dt><dd>${esc(data.item.descripcion)}</dd>
    <dt>Municipio</dt><dd>${esc(municipio)}</dd>
    <dt>Beneficiario</dt><dd>${esc(data.item.beneficiario)}</dd>
    <dt>OC</dt><dd class="codigo">${esc(data.numero_oc)}</dd>
    <dt>Estado</dt><dd>${etiquetaEstado(data.item.estado_actual)}</dd>`;
  $('rec-motivo').value = '';
  $('rec-detalle').hidden = false;
  franja('ok', data.mensaje);
}

async function asignarEstadoRecepcion(estado) {
  if (!itemRecepcion) return;
  const { data, error } = await bd.rpc('cambiar_estado', {
    p_item_id: itemRecepcion.id, p_nuevo: estado,
    p_motivo: $('rec-motivo').value.trim() || null, p_origen: 'recepcion'
  });
  if (error) return mostrarError(error);
  franja('ok', `${data.codigo_qr} recibido como ${NOMBRE_ESTADO[data.estado_actual]}.`, 'Escanea el siguiente producto.');
  itemRecepcion = null;
  $('rec-detalle').hidden = true;
  $('rec-codigo').value = '';
  $('rec-codigo').focus();
}


/* ---------- 10. Validación municipal (FL-05 y FL-08) ---------- */
alAbrirVista.validacion = async () => {
  const mios = datos.municipios.filter((m) => datos.misMunicipios.includes(m.id));
  if (!mios.length) {
    $('val-lista').innerHTML = '<tr><td colspan="6" class="vacio"><strong>No tienes municipios asignados.</strong> Pide al Coordinador que te los asigne.</td></tr>';
    return;
  }
  llenarSelect($('val-municipio'), mios, 'id', 'nombre', 'Todos mis municipios');
  await listarValidacion();
};

async function listarValidacion() {
  const municipio = $('val-municipio').value;
  const estado = $('val-estado').value;
  const texto = $('val-buscar').value.trim();

  let consulta = bd.from('vista_items').select('id, codigo_qr, producto, municipio, numero_oc, estado_actual')
    .eq('estado_actual', estado).order('id').limit(300);
  consulta = municipio ? consulta.eq('municipio_id', municipio) : consulta.in('municipio_id', datos.misMunicipios);
  if (texto) consulta = consulta.or(`codigo_qr.ilike.%${texto}%,producto.ilike.%${texto}%`);

  const { data, error } = await consulta;
  if (error) return mostrarError(error);

  // Solo se ofrecen los cambios que la tabla de transiciones permite al rol
  const destinos = datos.transiciones.filter((t) => t.estado_origen === estado);
  $('val-lista').innerHTML = data.length ? data.map((i) => `
    <tr>
      <td data-titulo="Código" class="cod">${esc(i.codigo_qr)}</td>
      <td data-titulo="Producto">${esc(i.producto)}</td>
      <td data-titulo="Municipio">${esc(i.municipio)}</td>
      <td data-titulo="OC" class="cod">${esc(i.numero_oc)}</td>
      <td data-titulo="Estado">${etiquetaEstado(i.estado_actual)}</td>
      <td data-titulo="Cambiar a">${destinos.map((t) => `
        <button type="button" class="btn btn-chico btn-estado estado-${t.estado_destino}"
          data-item="${i.id}" data-codigo="${esc(i.codigo_qr)}" data-destino="${t.estado_destino}"
          data-motivo="${t.motivo_obligatorio}">Marcar ${esc(NOMBRE_ESTADO[t.estado_destino])}</button>`).join(' ') || '—'}
      </td>
    </tr>`).join('')
    : `<tr><td colspan="6" class="vacio"><strong>No hay ítems en ${esc(NOMBRE_ESTADO[estado])}.</strong> Cambia el filtro o espera nuevas recepciones.</td></tr>`;
}

async function validarItem(boton) {
  const destino = boton.dataset.destino;
  const obligatorio = boton.dataset.motivo === 'true';
  // FL-08: escribir motivo
  const motivo = prompt(`${boton.dataset.codigo} → ${NOMBRE_ESTADO[destino]}\nMotivo${obligatorio ? ' (obligatorio)' : ' (opcional)'}:`, '');
  if (motivo === null) return; // canceló
  if (obligatorio && !motivo.trim()) return franja('error', 'El motivo es obligatorio para este cambio.');

  const origen = $('val-estado').value === 'EN_VALIDACION' ? 'validacion' : 'correccion';
  const { data, error } = await bd.rpc('cambiar_estado', {
    p_item_id: Number(boton.dataset.item), p_nuevo: destino, p_motivo: motivo.trim() || null, p_origen: origen
  });
  if (error) return mostrarError(error);
  franja('ok', `${data.codigo_qr} marcado como ${NOMBRE_ESTADO[data.estado_actual]}.`);
  listarValidacion();
}


/* ---------- 11. Salida ---------- */
alAbrirVista.salida = () => $('sal-codigo').focus();

async function registrarSalida(codigo) {
  codigo = String(codigo || '').trim();
  if (!codigo) return franja('error', 'Escribe o escanea un código.');
  const { data, error } = await bd.rpc('escanear_salida', {
    p_codigo: codigo, p_observacion: $('sal-obs').value.trim() || null
  });
  if (error) return mostrarError(error);

  if (data.ok) franja('ok', `${data.item.codigo_qr} entregado.`, 'Escanea el siguiente ítem.');
  else franja('error', data.mensaje, 'La incidencia quedó registrada.');

  // Agrega la fila al registro de esta sesión
  const lista = $('sal-lista');
  if (lista.querySelector('.vacio')) lista.innerHTML = '';
  lista.insertAdjacentHTML('afterbegin', `<tr>
    <td>${new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' })}</td>
    <td class="cod">${esc(data.item?.codigo_qr || codigo.toUpperCase())}</td>
    <td>${esc(data.item?.producto || '—')}</td>
    <td>${data.ok ? etiquetaEstado('ENTREGADO') : esc(data.mensaje)}</td></tr>`);
  $('sal-codigo').value = '';
  $('sal-obs').value = '';
  $('sal-codigo').focus();
}


/* ---------- 12. Tablero, cuadre y exportación ---------- */
let filasTablero = [];   // ítems con los filtros aplicados (lo mismo que se exporta)

alAbrirVista.tablero = async () => {
  llenarSelect($('f-municipio'), datos.municipios, 'id', 'nombre', 'Todos');
  llenarSelect($('f-proveedor'), datos.proveedores, 'id', 'nombre', 'Todos');
  llenarSelect($('f-estado'), Object.keys(NOMBRE_ESTADO).map((k) => ({ k, n: NOMBRE_ESTADO[k] })), 'k', 'n', 'Todos');
  const { data } = await bd.from('ordenes_compra').select('id, numero_oc').order('numero_oc');
  llenarSelect($('f-oc'), data || [], 'id', 'numero_oc', 'Todas');
};

function consultaFiltrada() {
  let c = bd.from('vista_items').select('*').order('id');
  if ($('f-municipio').value) c = c.eq('municipio_id', $('f-municipio').value);
  if ($('f-oc').value) c = c.eq('orden_id', $('f-oc').value);
  if ($('f-proveedor').value) c = c.eq('proveedor_id', $('f-proveedor').value);
  if ($('f-estado').value) c = c.eq('estado_actual', $('f-estado').value);
  const texto = $('f-texto').value.trim();
  if (texto) c = c.or(`codigo_qr.ilike.%${texto}%,producto.ilike.%${texto}%`);
  if ($('f-desde').value) c = c.gte('creado_en', $('f-desde').value + 'T00:00:00-05:00');
  if ($('f-hasta').value) c = c.lte('creado_en', $('f-hasta').value + 'T23:59:59-05:00');
  return c;
}

async function ejecutarCuadre(evento) {
  evento?.preventDefault();
  try {
    filasTablero = await traerTodo(consultaFiltrada);
  } catch (e) { return mostrarError(e); }

  // KPI (sección 6 del plan)
  const cuenta = (estado) => filasTablero.filter((i) => i.estado_actual === estado).length;
  const generados = filasTablero.length;
  const recibidos = generados - cuenta('GENERADO');
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  const kpis = [
    ['Ítems generados', generados],
    ['Ítems recibidos', recibidos],
    ['Ítems pendientes', generados - recibidos],
    ['% de recepción', pct(recibidos, generados) + ' %'],
    ['En validación', cuenta('EN_VALIDACION')],
    ['Validados por despachar', cuenta('VALIDADO')],
    ['Entregados', cuenta('ENTREGADO')],
    ['% de entrega', pct(cuenta('ENTREGADO'), generados) + ' %'],
    ['PNC', cuenta('PNC')],
    ['% de PNC', pct(cuenta('PNC'), recibidos) + ' %'],
    ['Devolución', cuenta('DEVOLUCION')]
  ];
  $('kpis').innerHTML = kpis.map(([n, v]) =>
    `<div class="kpi"><div class="kpi-valor">${esc(v)}</div><div class="kpi-nombre">${esc(n)}</div></div>`).join('');

  // Cuadre (FL-09): agrupa por municipio y OC
  const grupos = new Map();
  filasTablero.forEach((i) => {
    const clave = i.municipio + '|' + i.numero_oc;
    if (!grupos.has(clave)) grupos.set(clave, { municipio: i.municipio, oc: i.numero_oc, esperados: 0, GENERADO: 0, VALIDADO: 0, ENTREGADO: 0, PNC: 0, DEVOLUCION: 0 });
    const g = grupos.get(clave);
    g.esperados++;
    if (g[i.estado_actual] !== undefined) g[i.estado_actual]++;
  });
  const filas = [...grupos.values()].sort((a, b) => (a.municipio + a.oc).localeCompare(b.municipio + b.oc));
  $('cuadre-lista').innerHTML = filas.length ? filas.map((g) => `<tr>
    <td>${esc(g.municipio)}</td><td class="cod">${esc(g.oc)}</td>
    <td class="num">${g.esperados}</td><td class="num">${g.esperados - g.GENERADO}</td>
    <td class="num">${g.GENERADO}</td><td class="num">${g.VALIDADO}</td><td class="num">${g.ENTREGADO}</td>
    <td class="num">${g.PNC}</td><td class="num">${g.DEVOLUCION}</td></tr>`).join('')
    : '<tr><td colspan="9" class="vacio"><strong>No hay ítems con estos filtros.</strong> Amplía el rango de fechas o limpia los filtros.</td></tr>';

  // Sobrantes e inconsistencias: lecturas sin ítem esperado (de las incidencias)
  let inc = bd.from('vista_cuadre_incidencias').select('resultado_cuadre');
  if ($('f-desde').value) inc = inc.gte('fecha_hora', $('f-desde').value + 'T00:00:00-05:00');
  if ($('f-hasta').value) inc = inc.lte('fecha_hora', $('f-hasta').value + 'T23:59:59-05:00');
  const { data: incid } = await inc.limit(5000);
  const sobrantes = (incid || []).filter((x) => x.resultado_cuadre === 'SOBRANTE').length;
  const inconsistencias = (incid || []).length - sobrantes;
  $('cuadre-sobrantes').textContent =
    `Lecturas sin ítem esperado (sobrantes): ${sobrantes} · Inconsistencias: ${inconsistencias} (según rango de fechas).`;

  $('btn-csv').disabled = filasTablero.length === 0;
  $('btn-pdf').disabled = filasTablero.length === 0;
}

function limpiarFiltros() {
  $('tab-filtros').reset();
  filasTablero = [];
  $('kpis').innerHTML = '';
  $('cuadre-lista').innerHTML = '<tr><td colspan="9" class="vacio">Pulsa <strong>Ejecutar cuadre</strong> para ver los resultados.</td></tr>';
  $('cuadre-sobrantes').textContent = '';
  $('btn-csv').disabled = true;
  $('btn-pdf').disabled = true;
}

// CSV que Excel abre directo: separador ; y marca UTF-8 (BOM) para las tildes
function exportarCSV() {
  const columnas = [
    ['codigo_qr', 'Código QR'], ['producto', 'Producto'], ['descripcion', 'Descripción'],
    ['municipio', 'Municipio'], ['beneficiario', 'Beneficiario'], ['numero_oc', 'OC'],
    ['proveedor', 'Proveedor'], ['comprador', 'Comprador'], ['estado_actual', 'Estado'],
    ['creado_en', 'Generado'], ['recibido_en', 'Recibido'], ['recibido_por', 'Recibido por'],
    ['ultimo_cambio_en', 'Último cambio'], ['ultimo_cambio_por', 'Último cambio por']
  ];
  const celda = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lineas = [columnas.map((c) => celda(c[1])).join(';')];
  filasTablero.forEach((f) => {
    lineas.push(columnas.map(([k]) => {
      if (k === 'estado_actual') return celda(NOMBRE_ESTADO[f[k]]);
      if (k.endsWith('_en')) return celda(fechaHora(f[k]));
      return celda(f[k]);
    }).join(';'));
  });
  const archivo = new Blob(['﻿' + lineas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const enlace = document.createElement('a');
  enlace.href = URL.createObjectURL(archivo);
  enlace.download = `cuadre-hevequi-${hoy()}.csv`;
  enlace.click();
  URL.revokeObjectURL(enlace.href);
}


/* ---------- 13. Historial del ítem ---------- */
async function verHistorial(evento) {
  evento.preventDefault();
  const codigo = $('his-codigo').value.trim().toUpperCase();
  const { data: item, error } = await bd.from('vista_items').select('*').eq('codigo_qr', codigo).maybeSingle();
  if (error) return mostrarError(error);
  if (!item) {
    $('his-datos').hidden = true;
    $('his-lista').innerHTML = '<tr><td colspan="6" class="vacio"><strong>No existe un ítem con ese código.</strong> Revisa que esté bien escrito.</td></tr>';
    return;
  }
  $('his-datos').innerHTML = `
    <dt>Código</dt><dd class="codigo">${esc(item.codigo_qr)}</dd>
    <dt>Producto</dt><dd>${esc(item.producto)}</dd>
    <dt>Municipio</dt><dd>${esc(item.municipio)}</dd>
    <dt>OC</dt><dd class="codigo">${esc(item.numero_oc)} · ${esc(item.proveedor)}</dd>
    <dt>Estado</dt><dd>${etiquetaEstado(item.estado_actual)}</dd>`;
  $('his-datos').hidden = false;

  const { data: movs, error: e2 } = await bd.from('movimientos_estado')
    .select('fecha_hora, estado_anterior, estado_nuevo, origen, motivo, usuarios(nombre)')
    .eq('item_id', item.id).order('fecha_hora', { ascending: false }).order('id', { ascending: false });
  if (e2) return mostrarError(e2);
  $('his-lista').innerHTML = movs.map((m) => `<tr>
    <td>${fechaHora(m.fecha_hora)}</td>
    <td>${m.estado_anterior ? etiquetaEstado(m.estado_anterior) : '—'}</td>
    <td>${etiquetaEstado(m.estado_nuevo)}</td>
    <td>${esc(m.usuarios?.nombre || 'Sistema')}</td>
    <td>${esc(m.origen)}</td><td>${esc(m.motivo)}</td></tr>`).join('');
}


/* ---------- 14. Usuarios y auditoría (FL-10) ---------- */
alAbrirVista.usuarios = async () => {
  $('usu-municipios-lista').innerHTML = datos.municipios.map((m) =>
    `<label><input type="checkbox" value="${m.id}"> ${esc(m.nombre)}</label>`).join('')
    || '<p class="nota">Primero agrega municipios.</p>';
  mostrarMunicipiosAuxiliar();
  await Promise.all([listarUsuarios(), listarAuditoria()]);
};

function mostrarMunicipiosAuxiliar() {
  $('usu-municipios').hidden = $('usu-rol').value !== 'auxiliar';
}

async function listarUsuarios() {
  const { data, error } = await bd.from('usuarios')
    .select('id, nombre, correo, rol, activo, usuario_municipio(municipios(nombre))').order('nombre');
  if (error) return mostrarError(error);
  $('usu-lista').innerHTML = data.map((u) => `<tr>
    <td>${esc(u.nombre)}</td><td>${esc(u.correo)}</td>
    <td><select class="usu-cambiar-rol" data-id="${u.id}" aria-label="Rol de ${esc(u.nombre)}">
      ${Object.keys(NOMBRE_ROL).map((r) => `<option value="${r}" ${r === u.rol ? 'selected' : ''}>${NOMBRE_ROL[r]}</option>`).join('')}
    </select></td>
    <td>${esc(u.usuario_municipio.map((x) => x.municipios?.nombre).join(', ') || '—')}</td>
    <td>${u.activo ? 'Activo' : 'Inactivo'}</td>
    <td><button type="button" class="btn btn-chico usu-activar" data-id="${u.id}" data-activo="${u.activo}">
      ${u.activo ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('');
}

async function crearUsuario(evento) {
  evento.preventDefault();
  const rol = $('usu-rol').value;
  const municipios = [...$('usu-municipios-lista').querySelectorAll('input:checked')].map((c) => Number(c.value));
  if (rol === 'auxiliar' && !municipios.length) return franja('error', 'Asigna al menos un municipio al Auxiliar.');

  const { data, error } = await bd.from('usuarios').insert({
    correo: $('usu-correo').value.trim().toLowerCase(), nombre: $('usu-nombre').value.trim(), rol
  }).select('id').single();
  if (error) return mostrarError(error);

  if (rol === 'auxiliar') {
    const { error: e2 } = await bd.from('usuario_municipio').insert(municipios.map((m) => ({ usuario_id: data.id, municipio_id: m })));
    if (e2) return mostrarError(e2);
  }
  franja('ok', 'Usuario creado.', 'Ya puede ingresar con su cuenta de Google.');
  $('form-usuario').reset();
  mostrarMunicipiosAuxiliar();
  listarUsuarios();
  listarAuditoria();
}

async function cambiarUsuario(id, cambios, texto) {
  if (id === datos.perfil.id && !confirm('Vas a cambiar tu propio usuario y podrías perder el acceso. ¿Continuar?')) {
    return listarUsuarios();
  }
  const { error } = await bd.from('usuarios').update(cambios).eq('id', id);
  if (error) mostrarError(error); else franja('ok', texto);
  listarUsuarios();
  listarAuditoria();
}

async function agregarMunicipio() {
  const nombre = $('mun-nombre').value.trim();
  if (!nombre) return franja('error', 'Escribe el nombre del municipio.');
  const { data, error } = await bd.from('municipios').insert({ nombre }).select('id, nombre').single();
  if (error) return mostrarError(error);
  datos.municipios.push(data);
  datos.municipios.sort((a, b) => a.nombre.localeCompare(b.nombre));
  $('mun-nombre').value = '';
  franja('ok', 'Municipio agregado: ' + data.nombre);
  alAbrirVista.usuarios();
}

async function listarAuditoria() {
  const { data, error } = await bd.from('auditoria')
    .select('fecha_hora, tabla, accion, registro_id, usuario_id').order('id', { ascending: false }).limit(100);
  if (error) return mostrarError(error);
  const { data: usuarios } = await bd.from('usuarios').select('id, nombre');
  const nombre = (id) => usuarios?.find((u) => u.id === id)?.nombre || 'Sistema';
  $('aud-lista').innerHTML = data.length ? data.map((a) => `<tr>
    <td>${fechaHora(a.fecha_hora)}</td><td>${esc(a.tabla)}</td><td>${esc(a.accion)}</td>
    <td class="cod">${esc(a.registro_id)}</td><td>${esc(nombre(a.usuario_id))}</td></tr>`).join('')
    : '<tr><td colspan="5" class="vacio">Aún no hay cambios registrados.</td></tr>';
}


/* ---------- 15. Arranque ---------- */
function conectarEventos() {
  $('btn-google').onclick = iniciarSesion;
  $('btn-salir').onclick = cerrarSesion;
  $('btn-menu').onclick = () => abrirMenu(!$('menu').classList.contains('abierto'));
  document.querySelectorAll('#menu [data-vista]').forEach((b) => { b.onclick = () => cambiarVista(b.dataset.vista); });

  // Órdenes y QR
  $('btn-agregar-item').onclick = filaItemOrden;
  $('btn-proveedor').onclick = agregarProveedor;
  $('form-orden').onsubmit = guardarOrden;
  $('qr-orden').onchange = mostrarEtiquetas;
  $('btn-imprimir-qr').onclick = imprimirQR;

  // Recepción
  $('rec-camara').onclick = () => encenderCamara($('rec-video'), (codigo) => { $('rec-codigo').value = codigo; validarRecepcion(codigo); });
  $('rec-form').onsubmit = (e) => { e.preventDefault(); validarRecepcion($('rec-codigo').value); };
  document.querySelectorAll('#rec-detalle [data-estado]').forEach((b) => { b.onclick = () => asignarEstadoRecepcion(b.dataset.estado); });

  // Validación
  $('val-municipio').onchange = listarValidacion;
  $('val-estado').onchange = listarValidacion;
  let espera;
  $('val-buscar').oninput = () => { clearTimeout(espera); espera = setTimeout(listarValidacion, 400); };
  $('val-lista').onclick = (e) => { const b = e.target.closest('[data-destino]'); if (b) validarItem(b); };

  // Salida
  $('sal-camara').onclick = () => encenderCamara($('sal-video'), registrarSalida);
  $('sal-form').onsubmit = (e) => { e.preventDefault(); registrarSalida($('sal-codigo').value); };

  // Tablero
  $('tab-filtros').onsubmit = ejecutarCuadre;
  $('btn-limpiar').onclick = limpiarFiltros;
  $('btn-csv').onclick = exportarCSV;
  $('btn-pdf').onclick = () => window.print();

  // Historial
  $('his-form').onsubmit = verHistorial;

  // Usuarios
  $('form-usuario').onsubmit = crearUsuario;
  $('usu-rol').onchange = mostrarMunicipiosAuxiliar;
  $('btn-municipio').onclick = agregarMunicipio;
  $('usu-lista').onchange = (e) => {
    if (e.target.matches('.usu-cambiar-rol')) {
      cambiarUsuario(Number(e.target.dataset.id), { rol: e.target.value }, 'Rol actualizado.');
    }
  };
  $('usu-lista').onclick = (e) => {
    const b = e.target.closest('.usu-activar');
    if (b) {
      const activar = b.dataset.activo !== 'true';
      cambiarUsuario(Number(b.dataset.id), { activo: activar }, activar ? 'Usuario activado.' : 'Usuario desactivado.');
    }
  };
}

async function arrancar() {
  conectarEventos();
  if (!configurado) {
    mensajeIngreso('Falta configurar Supabase: escribe la URL y la clave pública al inicio de app.js.');
    return;
  }
  // Supabase avisa cuando cambia la sesión (también al volver de Google)
  bd.auth.onAuthStateChange((evento, sesion) => {
    if (evento === 'SIGNED_OUT') return;
    if (sesion && !datos.perfil) setTimeout(cargarPerfil, 0); // fuera del aviso, como pide Supabase
  });
}

arrancar();
