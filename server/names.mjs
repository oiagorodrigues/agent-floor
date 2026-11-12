import { randomInt } from 'node:crypto';

export const NAMES = [
  'Ada', 'Alba', 'Alma', 'Amara', 'Ana', 'Anika', 'Arlo', 'Aurora', 'Bea', 'Bento', 'Bia', 'Bruno',
  'Caio', 'Cata', 'Cleo', 'Dalia', 'Dante', 'Davi', 'Dina', 'Duda', 'Edu', 'Elio', 'Ema', 'Enzo',
  'Esme', 'Fabi', 'Faye', 'Felix', 'Flora', 'Gael', 'Gigi', 'Gus', 'Hana', 'Hugo', 'Ines', 'Iris',
  'Ivo', 'Jade', 'Joca', 'Juju', 'Kai', 'Kira', 'Lara', 'Leo', 'Lia', 'Lino', 'Lola', 'Luca',
  'Lulu', 'Mabel', 'Maia', 'Malu', 'Mateo', 'Mia', 'Milo', 'Mira', 'Nadia', 'Nico', 'Nina', 'Noa',
  'Olga', 'Omar', 'Otto', 'Pepe', 'Pia', 'Pipo', 'Quim', 'Rafa', 'Remy', 'Rita', 'Rocco', 'Rosa',
  'Rui', 'Sami', 'Sara', 'Sol', 'Tatu', 'Teo', 'Tina', 'Tito', 'Uma', 'Vera', 'Vico', 'Wanda',
  'Xavi', 'Yara', 'Yuki', 'Zara', 'Zeca', 'Zoe',
];

/** A first name no agent on the floor has yet. Once all are taken, names get a number. */
export function pickName(taken, rand = randomInt) {
  const free = NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[rand(free.length)];
  for (let i = 2; ; i++) {
    const name = `${NAMES[rand(NAMES.length)]} ${i}`;
    if (!taken.has(name)) return name;
  }
}
