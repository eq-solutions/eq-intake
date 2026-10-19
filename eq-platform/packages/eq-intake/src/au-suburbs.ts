/**
 * Suburbs that have exactly one postcode, so a blank postcode can be filled in with
 * no guessing. Only suburbs listed here are used; a suburb with two postcodes, or one
 * not on the list, is left alone. Postcodes are Australia Post's.
 */

export interface KnownSuburb {
  state: 'NSW' | 'ACT';
  postcode: string;
}

const NSW: Record<string, string> = {
  'alexandria': '2015', 'artarmon': '2064', 'auburn': '2144', 'baulkham hills': '2153', 'banksmeadow': '2019',
  'barangaroo': '2000', 'bella vista': '2153', 'blacktown': '2148', 'botany': '2019', 'brookvale': '2100',
  'campbelltown': '2560', 'carrington': '2294', 'castle hill': '2154', 'chatswood': '2067', 'darlinghurst': '2010',
  'dee why': '2099', 'eastern creek': '2766', 'epping': '2121', 'frenchs forest': '2086', 'gosford': '2250',
  'granville': '2142', 'homebush': '2140', 'hornsby': '2077', 'hoxton park': '2171', 'hunters hill': '2110',
  'huntingwood': '2148', 'ingleburn': '2565', 'kellyville': '2155', 'kemps creek': '2178', 'lane cove west': '2066',
  'lidcombe': '2141', 'liverpool': '2170', 'macquarie park': '2113', 'mascot': '2020', 'minto': '2566',
  'moorebank': '2170', 'mount druitt': '2770', 'newcastle': '2300', 'north ryde': '2113', 'north sydney': '2060',
  'parramatta': '2150', 'penrith': '2750', 'port kembla': '2505', 'prospect': '2148', 'pyrmont': '2009',
  'rooty hill': '2766', 'rosehill': '2142', 'rouse hill': '2155', 'ryde': '2112', 'rydalmere': '2116',
  'seven hills': '2147', 'silverwater': '2128', 'smithfield': '2164', 'st leonards': '2065', 'strathfield': '2135',
  'sydney': '2000', 'ultimo': '2007', 'westmead': '2145', 'wetherill park': '2164', 'wollongong': '2500',
  'zetland': '2017',
};

const ACT: Record<string, string> = { 'fyshwick': '2609', 'hume': '2620' };

const TABLE = new Map<string, KnownSuburb>();
for (const [k, v] of Object.entries(NSW)) TABLE.set(k, { state: 'NSW', postcode: v });
for (const [k, v] of Object.entries(ACT)) TABLE.set(k, { state: 'ACT', postcode: v });

export function knownSuburb(suburb: string): KnownSuburb | null {
  return TABLE.get(suburb.trim().toLowerCase().replace(/\s+/g, ' ')) ?? null;
}
