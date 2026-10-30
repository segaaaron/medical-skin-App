// Las contraseñas más usadas. `acceso.md`: «8 caracteres mínimo y comprobación contra la
// lista de las más usadas, **sin exigir mayúscula-número-símbolo**: esa exigencia produce
// `Password1!` y nada más».
//
// ponytail: lista corta embebida (las más usadas de las filtraciones públicas, más las
// variantes en español que una lista en inglés no trae). No es una lista de 10 000: eso es
// un archivo de 100 kB cargado en memoria en cada arranque para un endpoint que se llama
// una vez por persona. Si hiciera falta más cobertura, el camino es un Bloom filter en
// Redis sembrado desde el despliegue, no hacer este archivo más grande.

const LIST = [
  '123456', '123456789', '12345678', 'password', 'qwerty', '12345', 'qwerty123', '1q2w3e',
  '111111', '1234567890', '1234567', '000000', '123123', '987654321', 'abc123', 'iloveyou',
  'dragon', 'monkey', 'sunshine', 'princess', 'football', 'baseball', 'welcome', 'shadow',
  'master', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'letmein', 'trustno1', 'passw0rd',
  'password1', 'password123', 'p@ssword', 'p@ssw0rd', 'admin', 'administrator', 'root',
  'default', 'changeme', 'secret', 'login', 'guest', 'test1234', 'temporal', 'whatever',
  'superman', 'batman', 'pokemon', 'starwars', 'michael', 'jennifer', 'jordan', 'hunter',
  'ranger', 'buster', 'thomas', 'summer', 'ashley', 'daniel', 'charlie', 'maggie',
  'computer', 'internet', 'samsung', 'google', 'facebook', 'instagram', 'whatsapp',
  'qazwsx', '1qaz2wsx', 'zaq12wsx', 'q1w2e3r4', 'a1b2c3d4', 'aaaaaa', 'asdfgh', '654321',
  '112233', '121212', '696969', '55555555', '66666666', '77777777', '88888888', '99999999',
  '11111111', '22222222', '33333333', 'football1', 'soccer', 'basketball', 'jesus',
  'jesuscristo', 'dios', 'diosesamor', 'amor', 'teamo', 'teamomucho', 'mivida', 'miamor',
  'cariño', 'carino', 'bonita', 'hermosa', 'princesa', 'reina', 'mariposa', 'estrella',
  'corazon', 'corazón', 'familia', 'mama', 'mamá', 'papa', 'papá', 'hola', 'holahola',
  'holamundo', 'bienvenido', 'contrasena', 'contraseña', 'contrasena1', 'clave', 'clave123',
  'secreto', 'usuario', 'administrador', 'invitado', 'prueba', 'pruebas', 'ejemplo',
  'boliviana', 'bolivia', 'bolivia123', 'santacruz', 'lapaz', 'cochabamba', 'argentina',
  'mexico', 'méxico', 'colombia', 'chile', 'peru', 'perú', 'españa', 'espana', 'barcelona',
  'realmadrid', 'bocajuniors', 'river', 'america', 'américa', 'cristiano', 'messi',
  'medskin', 'medskin123', 'doctor', 'clinica', 'clínica', 'consultorio', 'patient',
  'enero', 'febrero', 'marzo', 'verano', 'invierno', 'primavera', 'otoño', 'otono',
] as const;

const INDEX: ReadonlySet<string> = new Set(LIST);

/** Insensible a mayúsculas: `PASSWORD` es la misma contraseña usada que `password`. */
export function isCommonPassword(password: string): boolean {
  return INDEX.has(password.toLowerCase());
}
