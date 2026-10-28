// La contraseña temporal · `cuentas.md`: 72 h, un solo uso, y «no se negocia por canal».
//
// La forma es la del contrato, `tejado-lila-07`: dos palabras y dos dígitos, separados por
// guiones. Y la forma es una decisión, no un adorno: esta contraseña la dicta una doctora
// por teléfono o la copia en un WhatsApp, así que tiene que poder leerse en voz alta sin
// deletrear. Una cadena aleatoria de doce caracteres sería más fuerte y acabaría escrita en
// un papel.
//
// LO QUE ESO CUESTA, dicho sin rodeos: 128 × 64 × 100 son 819 200 combinaciones, 19,6 bits.
// Para un secreto permanente sería inaceptable. Lo que lo hace suficiente aquí son las tres
// cosas que la acotan y que no son negociables:
//   · vive 72 h y es de un solo uso;
//   · adivinarla por la puerta del acceso cuesta 5 intentos cada 15 minutos por correo
//     (`acceso.md`), o sea unos 480 intentos al día: 1 700 años de media;
//   · y ese contador cuenta igual para un correo que no existe, así que ni siquiera se
//     puede medir si el correo es real antes de empezar.
// Si algún día el límite de intentos se relaja, esta cuenta deja de salir y la forma tiene
// que cambiar con él.

import { randomInt } from 'node:crypto';

/** «72 h y un solo uso. No se negocia por canal: la de WhatsApp y la de correo son la misma.» */
export const TEMPORARY_PASSWORD_HOURS = 72;

// Sustantivos concretos y cortos, sin tildes ni ñ: esta palabra se escribe en el teclado de
// un teléfono y se dicta por teléfono. Nada del cuerpo, de la piel ni de un tratamiento: la
// contraseña viaja por WhatsApp y no dice a qué se dedica quien la manda.
const NOUNS = [
  'tejado', 'ventana', 'cometa', 'laguna', 'puente', 'faro', 'barco', 'remo',
  'cuaderno', 'lapiz', 'tinta', 'sobre', 'sello', 'brujula', 'mapa', 'reloj',
  'llave', 'puerta', 'balcon', 'patio', 'jardin', 'maceta', 'semilla', 'raiz',
  'tronco', 'rama', 'hoja', 'flor', 'fruto', 'grano', 'harina', 'pan',
  'queso', 'miel', 'sal', 'pimienta', 'canela', 'menta', 'cacao', 'cafe',
  'taza', 'plato', 'cuchara', 'olla', 'sarten', 'horno', 'mesa', 'silla',
  'banco', 'cojin', 'manta', 'sabana', 'almohada', 'cortina', 'alfombra', 'espejo',
  'cepillo', 'peine', 'jabon', 'toalla', 'cubeta', 'escoba', 'cuerda', 'nudo',
  'aguja', 'hilo', 'boton', 'tela', 'lana', 'seda', 'cuero', 'madera',
  'piedra', 'arena', 'barro', 'ladrillo', 'cemento', 'hierro', 'cobre', 'estano',
  'moneda', 'billete', 'bolsillo', 'mochila', 'maleta', 'bufanda', 'guante', 'sombrero',
  'bota', 'sandalia', 'bicicleta', 'patin', 'cohete', 'globo', 'avion', 'tren',
  'rueda', 'motor', 'volante', 'camino', 'sendero', 'cerro', 'valle', 'rio',
  'arroyo', 'cascada', 'playa', 'duna', 'bosque', 'pradera', 'nieve', 'niebla',
  'trueno', 'relampago', 'arcoiris', 'estrella', 'planeta', 'luna', 'eclipse', 'aurora',
  'tambor', 'guitarra', 'violin', 'flauta', 'piano', 'campana', 'silbato', 'eco',
] as const;

// Colores y adjetivos de color. La segunda palabra es la que el contrato ilustra con
// `lila`, y mantenerla en una familia cerrada hace la frase fácil de repetir.
const COLORS = [
  'lila', 'turquesa', 'carmin', 'indigo', 'azulado', 'verdoso', 'rojizo', 'dorado',
  'plateado', 'bronce', 'cobrizo', 'marfil', 'ambar', 'coral', 'salmon', 'durazno',
  'oliva', 'esmeralda', 'jade', 'menta', 'cian', 'cobalto', 'zafiro', 'violeta',
  'morado', 'fucsia', 'rosado', 'magenta', 'granate', 'vino', 'ladrillo', 'terracota',
  'ocre', 'mostaza', 'canela', 'chocolate', 'arena', 'beige', 'crema', 'perla',
  'gris', 'grafito', 'carbon', 'tinta', 'negro', 'blanco', 'nieve', 'humo',
  'celeste', 'cielo', 'marino', 'petroleo', 'musgo', 'pino', 'lima', 'limon',
  'naranja', 'mandarina', 'cereza', 'frambuesa', 'uva', 'ciruela', 'lavanda', 'malva',
] as const;

/**
 * `randomInt` y no `Math.random()`: es el generador criptográfico de Node y además reparte
 * sin el sesgo del módulo. Los dos dígitos van con cero delante, como en el contrato.
 */
export function mintTemporaryPassword(): string {
  const noun = NOUNS[randomInt(0, NOUNS.length)];
  const color = COLORS[randomInt(0, COLORS.length)];
  const number = String(randomInt(0, 100)).padStart(2, '0');
  return `${noun}-${color}-${number}`;
}

/** Cuándo caduca una temporal acuñada ahora. La cota la comprueba además la base. */
export function temporaryPasswordExpiry(now: Date): Date {
  return new Date(now.getTime() + TEMPORARY_PASSWORD_HOURS * 60 * 60 * 1000);
}
