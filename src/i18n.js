// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the Edge, a secret nor the user name: only our own words,
// error codes, the address, and the host name, version and role of the Edge
// (checked by pattern).
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
const hours = (ms) => Math.max(1, Math.round(ms / 3_600_000));
export const delay = (ms) => {
  // Decided on the rounded seconds: 59.99 s is "1 min", never "60 s".
  const s = Math.round(ms / 1000);
  if (s >= 2 * 3600) return { en: `${hours(ms)} h`, fr: `${hours(ms)} h` };
  if (s >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** "18:02:05 UTC": an instant, never in the local time of a container. */
export const clock = (at) => `${new Date(at).toISOString().slice(11, 19)} UTC`;

/** Our words for an error code of src/openems/client.js. */
const REASON = {
  unreachable: { en: 'unreachable', fr: 'injoignable' },
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  closed: { en: 'connection closed by the Edge', fr: 'connexion fermée par l’Edge' },
  protocol: {
    en: 'answer that is not the OpenEMS JSON-RPC API (is it the right address and port?)',
    fr: 'réponse qui n’est pas l’API JSON-RPC d’OpenEMS (est-ce la bonne adresse et le bon port ?)',
  },
  refused: { en: 'password refused', fr: 'mot de passe refusé' },
  denied: {
    en: 'log-in accepted, but the values were refused (user rights or an older OpenEMS)',
    fr: 'connexion acceptée, mais les valeurs ont été refusées (droits de l’utilisateur ou OpenEMS ancien)',
  },
  busy: { en: 'a read is already running', fr: 'une lecture est déjà en cours' },
  aborted: { en: 'read stopped', fr: 'lecture arrêtée' },
};

export function reason(err) {
  return REASON[err?.code] ?? { en: 'unexpected error', fr: 'erreur inattendue' };
}

/** The lifetime counters in the texts (src/devices.js COUNTERS names). */
export const COUNTER_NAMES = {
  production: { en: 'production', fr: 'production' },
  consumption: { en: 'house consumption', fr: 'consommation de la maison' },
  gridBuy: { en: 'bought from the grid', fr: 'achat au réseau' },
  gridSell: { en: 'sold to the grid', fr: 'vente au réseau' },
  batteryCharge: { en: 'battery charge', fr: 'charge de la batterie' },
  batteryDischarge: { en: 'battery discharge', fr: 'décharge de la batterie' },
};

const kwh = (value) => Math.round(value * 1000) / 1000;

const sentences = (lang, list) => list.map((n) => n[lang]).join(' ');
const both = (list) => ({ en: sentences('en', list), fr: sentences('fr', list) });

const heldLine = ({ name, direction, from, to }) =>
  direction === 'down'
    ? {
        en: `Counter "${COUNTER_NAMES[name].en}": dropped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `Compteur « ${COUNTER_NAMES[name].fr} » : baisse de ${kwh(from)} à ${kwh(to)} kWh, retenue (la dernière valeur acceptée est renvoyée).`,
      }
    : {
        en: `Counter "${COUNTER_NAMES[name].en}": jumped from ${kwh(from)} to ${kwh(to)} kWh, held back (the last accepted value is sent again).`,
        fr: `Compteur « ${COUNTER_NAMES[name].fr} » : saut de ${kwh(from)} à ${kwh(to)} kWh, retenu (la dernière valeur acceptée est renvoyée).`,
      };

const ROLE = {
  guest: { en: 'guest', fr: 'invité' },
  owner: { en: 'owner', fr: 'propriétaire' },
  installer: { en: 'installer', fr: 'installateur' },
  admin: { en: 'admin', fr: 'admin' },
};

export const T = {
  problem: {
    address_missing: {
      en: 'Enter the IP address of the FEMS / OpenEMS Edge and its password in the configuration.',
      fr: 'Saisissez l’adresse IP du FEMS / de l’Edge OpenEMS et son mot de passe dans la configuration.',
    },
    address_invalid: {
      en: 'The address is not valid: enter an IP address or a host name, with an optional port (e.g. 192.168.1.60).',
      fr: 'L’adresse n’est pas valide : saisissez une adresse IP ou un nom d’hôte, avec un port éventuel (ex. 192.168.1.60).',
    },
    username_invalid: {
      en: 'The user name is not valid (at most 64 characters, no control character). Leave it empty for "x".',
      fr: 'L’identifiant n’est pas valide (64 caractères au plus, sans caractère de contrôle). Laissez-le vide pour « x ».',
    },
    password_missing: {
      en: 'Enter the password of the Edge (for a FEMS, the read-only guest password is "user").',
      fr: 'Saisissez le mot de passe de l’Edge (pour un FEMS, le mot de passe invité en lecture seule est « user »).',
    },
    password_invalid: {
      en: 'The password is not valid (at most 128 characters, no control character).',
      fr: 'Le mot de passe n’est pas valide (128 caractères au plus, sans caractère de contrôle).',
    },
  },
  connecting: {
    en: 'Reading the OpenEMS Edge…',
    fr: 'Lecture de l’Edge OpenEMS…',
  },
  /** getConfig() failed in `connected`: asked again without end. */
  configRetry: (wait) => ({
    en: `The configuration could not be read from Gladys: new try in ${delay(wait).en}.`,
    fr: `La configuration n’a pas pu être lue depuis Gladys : nouvel essai dans ${delay(wait).fr}.`,
  }),
  /** Not read yet in this start: the next read. */
  waiting: (at) => ({
    en: `OpenEMS: next read at ${clock(at)}.`,
    fr: `OpenEMS : prochaine lecture à ${clock(at)}.`,
  }),
  refused: (address) => ({
    en: `${address} refuses the password: check it (for a FEMS, "user" is the read-only guest), then save the configuration again. Reads stopped until then (the "Test the connection" button tries once).`,
    fr: `${address} refuse le mot de passe : vérifiez-le (pour un FEMS, « user » est l’invité en lecture seule), puis enregistrez de nouveau la configuration. Lectures arrêtées d’ici là (le bouton « Tester la connexion » fait un essai).`,
  }),
  failing: (address, err, wait) => ({
    en: `${address} could not be read (${reason(err).en}): new try in ${delay(wait).en}.`,
    fr: `${address} n’a pas pu être lu (${reason(err).fr}) : nouvel essai dans ${delay(wait).fr}.`,
  }),
  ok: (hostname, version, notes = []) =>
    both([
      {
        en: `OpenEMS Edge ${hostname} answering${version ? ` (OpenEMS ${version})` : ''}.`,
        fr: `L’Edge OpenEMS ${hostname} répond${version ? ` (OpenEMS ${version})` : ''}.`,
      },
      ...notes,
    ]),
  notes: {
    noDevice: {
      en: 'Create its device from the "Discover" tab to receive its values.',
      fr: 'Créez son appareil depuis l’onglet « Découverte » pour recevoir ses valeurs.',
    },
    noHostname: {
      en: 'The Edge did not give a readable host name this time: nothing published (its values only go to the device of its host name).',
      fr: 'L’Edge n’a pas donné de nom d’hôte lisible cette fois : rien n’est publié (ses valeurs ne vont qu’à l’appareil de son nom d’hôte).',
    },
    otherHost: {
      en: 'Another host name answers at this address: its own device is in Discovery, the old one gets no value.',
      fr: 'Un autre nom d’hôte répond à cette adresse : son propre appareil est dans la Découverte, l’ancien ne reçoit plus de valeur.',
    },
    role: (role) => ({
      en: `This password logs in as ${ROLE[role].en}: the read-only guest is enough (FEMS: "user"), the integration never changes anything.`,
      fr: `Ce mot de passe se connecte en ${ROLE[role].fr} : l’invité en lecture seule suffit (FEMS : « user »), l’intégration ne change jamais rien.`,
    }),
    storeUnreadable: {
      en: 'The file of the integration in /data cannot be read: it is left as it is, and the lifetime counters are not sent until it can be read again (restart the integration).',
      fr: 'Le fichier de l’intégration dans /data est illisible : il est laissé tel quel, et les compteurs à vie ne sont pas envoyés tant qu’il ne peut pas être relu (redémarrez l’intégration).',
    },
    storeFailed: {
      en: 'The file of the integration in /data cannot be written: the lifetime counters are not sent meanwhile; the other values are.',
      fr: 'Le fichier de l’intégration dans /data ne peut pas être écrit : les compteurs à vie ne sont pas envoyés entre-temps ; les autres valeurs le sont.',
    },
    held: (held) =>
      both([
        ...held.map(heldLine),
        {
          en: 'A drop or a jump is never taken by itself. If the counter was really reset or replaced (or the jump is right), click "Accept the held counter" twice in the configuration of the integration (the first click lists, the second accepts exactly what was listed). Saving the configuration accepts nothing.',
          fr: 'Une baisse ou un saut n’est jamais pris de lui-même. Si le compteur a vraiment été remis à zéro ou remplacé (ou si le saut est juste), cliquez deux fois sur « Accepter le compteur retenu » dans la configuration de l’intégration (le premier clic liste, le second accepte exactement ce qui a été listé). Enregistrer la configuration n’accepte rien.',
        },
      ]),
  },
  accept: {
    nothing: {
      en: 'No counter is held back: nothing to accept.',
      fr: 'Aucun compteur n’est retenu : rien à accepter.',
    },
    confirm: (held, within) =>
      both([
        {
          en: 'A second click accepts exactly these values:',
          fr: 'Un second clic accepte exactement ces valeurs :',
        },
        ...held.map((h) =>
          h.direction === 'down'
            ? {
                en: `${COUNTER_NAMES[h.name].en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (a reset or a new meter: counting goes on from ${kwh(h.to)} kWh, nothing counted for the drop).`,
                fr: `${COUNTER_NAMES[h.name].fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (remise à zéro ou nouveau compteur : le comptage reprend à ${kwh(h.to)} kWh, rien n’est compté pour la baisse).`,
              }
            : {
                en: `${COUNTER_NAMES[h.name].en}: ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh counted at once).`,
                fr: `${COUNTER_NAMES[h.name].fr} : ${kwh(h.from)} → ${kwh(h.to)} kWh (${kwh(h.to - h.from)} kWh comptés d’un coup).`,
              },
        ),
        {
          en: `Click "Accept the held counter" again, after a few seconds and within ${delay(within).en}, to accept them; accept only if this is real.`,
          fr: `Cliquez de nouveau sur « Accepter le compteur retenu », après quelques secondes et dans les ${delay(within).fr}, pour les accepter ; n’acceptez que si c’est réel.`,
        },
      ]),
    done: (accepted, changed) =>
      both([
        ...accepted.map((h) => ({
          en: `Accepted: ${COUNTER_NAMES[h.name].en} ${kwh(h.to)} kWh, sent at the next read.`,
          fr: `Accepté : ${COUNTER_NAMES[h.name].fr} ${kwh(h.to)} kWh, envoyé à la prochaine lecture.`,
        })),
        ...(changed.length > 0
          ? [
              {
                en: `Not accepted, the value changed since the first click: ${changed.map((h) => COUNTER_NAMES[h.name].en).join('; ')}. Click again to list it.`,
                fr: `Non accepté, la valeur a changé depuis le premier clic : ${changed.map((h) => COUNTER_NAMES[h.name].fr).join(' ; ')}. Cliquez de nouveau pour la lister.`,
              },
            ]
          : []),
        { en: 'A different value stays held.', fr: 'Une autre valeur reste retenue.' },
      ]),
  },
  test: {
    /** The values of the last read, in short. */
    ok: (address, hostname, values, version) => {
      const en = [];
      const fr = [];
      if (values.soc !== undefined) {
        en.push(`charge ${values.soc} %`);
        fr.push(`charge ${values.soc} %`);
      }
      if (values.productionPower !== undefined) {
        en.push(`production ${Math.round(values.productionPower)} W`);
        fr.push(`production ${Math.round(values.productionPower)} W`);
      }
      if (values.consumptionPower !== undefined) {
        en.push(`house ${Math.round(values.consumptionPower)} W`);
        fr.push(`maison ${Math.round(values.consumptionPower)} W`);
      }
      const soft = version
        ? { en: `, OpenEMS ${version}`, fr: `, OpenEMS ${version}` }
        : { en: '', fr: '' };
      return {
        en: `${address}: OpenEMS Edge ${hostname ?? '?'}, log-in accepted${soft.en}${en.length ? ` (${en.join(', ')})` : ''}.`,
        fr: `${address} : Edge OpenEMS ${hostname ?? '?'}, connexion acceptée${soft.fr}${fr.length ? ` (${fr.join(', ')})` : ''}.`,
      };
    },
    failed: (address, err) => ({
      en: `${address}: ${reason(err).en}.`,
      fr: `${address} : ${reason(err).fr}.`,
    }),
    /** The button never reads sooner than the pace: what is known, and when the next read can be. */
    notNow: (at) => ({
      en: `Not asked now (never faster than the reading interval): next read possible at ${clock(at)}.`,
      fr: `Non interrogé maintenant (jamais plus vite que l’intervalle de lecture) : prochaine lecture possible à ${clock(at)}.`,
    }),
    lastRead: (at) => ({
      en: `Last read at ${clock(at)}.`,
      fr: `Dernière lecture à ${clock(at)}.`,
    }),
    slow: {
      en: 'The Edge is slow to answer: look at the integration status in a minute.',
      fr: 'L’Edge tarde à répondre : regardez l’état de l’intégration dans une minute.',
    },
    lines: (lines) => both(lines),
  },
};
