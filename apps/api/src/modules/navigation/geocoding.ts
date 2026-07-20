import type { GeoPoint } from '../geofences/detect.js';

/**
 * Geocodificação (issue #131): endereço → coordenada, e o inverso.
 *
 * Mesma arquitetura do motor de rotas: o provedor fica atrás de uma interface, com o
 * Nominatim (OpenStreetMap) como adaptador de DESENVOLVIMENTO. Em produção isso não
 * adiciona decisão nova de infra — OpenRouteService, GraphHopper, Mapbox e Stadia
 * incluem geocodificação na MESMA chave do directions, então trocar o provedor de rotas
 * traz este junto.
 *
 * Fica no servidor, e não no app, por três motivos: a chave do provedor gerenciado
 * nunca desce para o dispositivo; o limite de 1 req/s e o `User-Agent` exigidos pelo
 * Nominatim são impostos num ponto só; e app e dashboard consomem o mesmo endpoint.
 */

/**
 * Resultado em DUAS linhas, como nos apps de navegação do mercado: a via em destaque e
 * a localidade abaixo, em tom secundário. Um rótulo único obrigaria a UI a fatiar
 * string para exibir — e o `display_name` do Nominatim tem oito níveis administrativos,
 * até "Região Sudeste" e "Brasil", que não ajudam quem está a dois quarteirões dali.
 */
export interface GeocodeResult {
  /** Linha principal: via com número, ou o nome do lugar. */
  title: string;
  /** Linha secundária: bairro · cidade. Pode ser vazia. */
  subtitle: string;
  /** `title` + `subtitle` — vira o rótulo da rota, que aparece na central. */
  label: string;
  lat: number;
  lng: number;
  /** Granularidade do acerto (`house`, `road`, `suburb`…) — ordena a lista na UI. */
  kind?: string;
  /** Número de porta, quando o mapa tem esse dado. Ausente ⇒ acerto no nível da via. */
  houseNumber?: string;
}

/**
 * Resposta da busca. É um envelope, e não uma lista pura, por causa do número de porta:
 * quando o número pedido não existe no mapa, o provedor devolve a VIA inteira sem avisar
 * — o operador pesquisa "Rua da Bahia 1601" e recebe três trechos de "Rua da Bahia",
 * sem pista de que o 1601 foi descartado. O envelope carrega esse fato para a UI poder
 * dizer em voz alta.
 */
export interface GeocodeResponse {
  results: GeocodeResult[];
  /** Número de porta detectado na consulta, se houver. */
  houseNumber?: string;
  /** `true` quando algum resultado realmente casou com esse número. */
  houseNumberMatched: boolean;
}

export interface GeocodingProvider {
  readonly name: string;
  /** `near` enviesa o resultado; sem ele, "Rua Bahia" devolve o Brasil inteiro. */
  search(query: string, near?: GeoPoint): Promise<GeocodeResponse>;
  reverse(point: GeoPoint): Promise<GeocodeResult | null>;
}

/**
 * Separa o número de porta do nome da via. O Nominatim é bem mais preciso na consulta
 * ESTRUTURADA (`street=1578 Avenida Paulista` acerta o 1578; o texto livre equivalente
 * devolve o 1600, o número mapeado mais próximo) — mas para usá-la é preciso saber onde
 * o nome termina e o número começa.
 *
 * A guarda dos dois termos existe porque em português o número às vezes É o nome da via:
 * "Rua 7", "Quadra 12". Exigir nome com pelo menos duas palavras antes do número separa
 * esse caso de "Rua da Bahia 1601". Nomes com número no meio ("Rua 15 de Novembro") não
 * casam com o padrão, que ancora no fim da string.
 */
export function parseHouseNumber(query: string): { street: string; houseNumber?: string } {
  // O sufixo de letra é comum no Brasil ("1212-A", "45B") e vai INTEIRO para o provedor:
  // é assim que o `addr:housenumber` costuma estar no mapa, e cortar a letra pediria
  // um número que não existe.
  const match = query.match(/^(.+?)[,\s]+(\d{1,6}(?:\s?[-/]?\s?[A-Za-z])?)\s*$/);
  if (!match) return { street: query.trim() };

  const street = match[1]!.trim();
  if (street.split(/\s+/).length < 2) return { street: query.trim() };
  return { street, houseNumber: match[2] };
}

/* --------------------------------------------------- Limite de uso e cache */

/**
 * A política de uso do Nominatim exige NO MÁXIMO 1 requisição por segundo. Não é
 * sugestão: abusar bloqueia o IP. Este encadeamento serializa TODAS as chamadas do
 * processo com espaçamento mínimo — o teto vale para o servidor inteiro, não por
 * requisição HTTP, então não adianta limitar no Fastify.
 */
const MIN_INTERVAL_MS = 1100;
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function throttled<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return task();
  });
  // `chain` nunca rejeita: uma falha não pode travar a fila das próximas chamadas.
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Cache em memória. A política do Nominatim pede explicitamente que resultados sejam
 * cacheados, e a geocodificação reversa é o caso mais crítico: sem cache, cada toque no
 * mapa vira uma chamada externa. Limite pequeno de propósito — é conveniência, não
 * fonte de verdade, e o processo não pode crescer sem teto.
 */
const MAX_CACHE = 200;
const cache = new Map<string, GeocodeResult[]>();

function cached(key: string): GeocodeResult[] | undefined {
  const hit = cache.get(key);
  if (hit) {
    // Reinsere para o descarte cair sempre no menos usado recentemente.
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

/**
 * Esvazia o cache. O cache é PROCESSO INTEIRO de propósito (o teto de 1 req/s do
 * Nominatim também é), então instâncias diferentes do provedor compartilham entradas —
 * ótimo em produção, mas deixa um teste enxergando o que o anterior cacheou. Daí este
 * gancho de isolamento.
 */
export function clearGeocodeCache(): void {
  cache.clear();
}

function remember(key: string, value: GeocodeResult[]): void {
  cache.set(key, value);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/* ------------------------------------------------------- Adaptador Nominatim */

interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  name?: string;
  addresstype?: string;
  type?: string;
  address?: Record<string, string>;
}

/**
 * Monta o rótulo curto. O `display_name` do Nominatim é longuíssimo ("Rua X, Bairro,
 * Cidade, Região, Microrregião, Mesorregião, Estado, Região, 30000-000, Brasil") e não
 * cabe numa lista de celular. Aqui sobra o que identifica o lugar para quem está em campo.
 */
function splitLabel(p: NominatimPlace): { title: string; subtitle: string } {
  const a = p.address ?? {};
  const street = a.road ?? a.pedestrian ?? a.footway ?? p.name;
  const number = a.house_number;
  const area = a.suburb ?? a.neighbourhood ?? a.city_district;
  const city = a.city ?? a.town ?? a.village ?? a.municipality;

  const title = street && number ? `${street}, ${number}` : (street ?? p.name ?? '');
  const subtitle = [area, city].filter(Boolean).join(' · ');

  // Sem via identificada (ponto no meio de uma quadra, área rural), o primeiro pedaço do
  // `display_name` ainda é melhor do que "Local sem nome".
  if (!title) {
    const head = (p.display_name ?? '').split(',')[0]?.trim();
    return { title: head || 'Local sem nome', subtitle };
  }
  return { title, subtitle };
}

function toResult(p: NominatimPlace): GeocodeResult | null {
  const lat = Number(p.lat);
  const lng = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const { title, subtitle } = splitLabel(p);
  return {
    title,
    subtitle,
    label: subtitle ? `${title} · ${subtitle}` : title,
    lat,
    lng,
    kind: p.addresstype ?? p.type,
    houseNumber: p.address?.house_number,
  };
}

/**
 * Remove acertos repetidos. Uma rua longa vira vários resultados no Nominatim (um por
 * trecho do traçado no OSM): buscar "Rua da Bahia" devolve a MESMA rua três vezes, com
 * coordenadas a poucas centenas de metros. Numa lista de celular isso é ruído puro —
 * o agente não tem como escolher entre três linhas idênticas.
 */
function dedupe(results: GeocodeResult[]): GeocodeResult[] {
  const seen = new Set<string>();
  return results.filter((r) => {
    const key = r.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Caixa (~±0,2° ≈ 22 km) em torno do ponto, para enviesar a busca sem restringi-la. */
function viewbox(near: GeoPoint): string {
  const d = 0.2;
  return `${near.lng - d},${near.lat - d},${near.lng + d},${near.lat + d}`;
}

export class NominatimGeocodingProvider implements GeocodingProvider {
  readonly name = 'nominatim';

  constructor(
    private readonly baseUrl: string,
    /**
     * A política do Nominatim EXIGE um User-Agent que identifique a aplicação. Requisição
     * sem isso é recusada — não é boa prática opcional, é requisito de acesso.
     */
    private readonly userAgent: string,
    private readonly countryCodes: string,
    private readonly timeoutMs = 8000,
  ) {}

  private async call(path: string): Promise<unknown | null> {
    return throttled(async () => {
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { 'User-Agent': this.userAgent, 'Accept-Language': 'pt-BR' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null; // sem rede, timeout ou provedor fora — quem chama devolve lista vazia
      }
    });
  }

  /** Parâmetros comuns às duas formas de consulta (livre e estruturada). */
  private baseParams(near?: GeoPoint): URLSearchParams {
    const params = new URLSearchParams({ format: 'jsonv2', addressdetails: '1', limit: '6' });
    if (this.countryCodes) params.set('countrycodes', this.countryCodes);
    if (near) {
      params.set('viewbox', viewbox(near));
      // `bounded=0`: prefere a área, mas ainda acha o endereço fora dela. Restringir de
      // vez esconderia um destino legítimo logo além do limite arbitrário da caixa.
      params.set('bounded', '0');
    }
    return params;
  }

  private async fetchPlaces(params: URLSearchParams): Promise<GeocodeResult[]> {
    const body = await this.call(`/search?${params.toString()}`);
    const places = Array.isArray(body) ? (body as NominatimPlace[]) : [];
    return dedupe(places.map(toResult).filter((r): r is GeocodeResult => r !== null));
  }

  async search(query: string, near?: GeoPoint): Promise<GeocodeResponse> {
    const key = `s:${query.toLowerCase()}:${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
    const { street, houseNumber } = parseHouseNumber(query);

    const hit = cached(key);
    if (hit) {
      return {
        results: hit,
        houseNumber,
        houseNumberMatched: hit.some((r) => r.houseNumber === houseNumber),
      };
    }

    let results: GeocodeResult[] = [];
    if (houseNumber) {
      // Consulta estruturada primeiro: é a que acerta o número exato em vez do mapeado
      // mais próximo. A cidade não vai junto porque não a conhecemos — o viés do
      // `viewbox` já ancora a busca na região da operação.
      const structured = this.baseParams(near);
      structured.set('street', `${houseNumber} ${street}`);
      results = await this.fetchPlaces(structured);
    }

    // Sem número, ou estruturada vazia: texto livre. Vale a pena mesmo quando o número
    // não existe no mapa — devolve a via, e o agente ajusta o ponto exato no mapa.
    if (results.length === 0) {
      const free = this.baseParams(near);
      free.set('q', query);
      results = await this.fetchPlaces(free);
    }

    remember(key, results);
    return {
      results,
      houseNumber,
      // Só é "casado" se algum resultado trouxer O número pedido. Sem isso a UI não tem
      // como distinguir "achei a porta" de "achei a rua e joguei o número fora".
      houseNumberMatched: results.some((r) => r.houseNumber === houseNumber),
    };
  }

  async reverse(point: GeoPoint): Promise<GeocodeResult | null> {
    // Arredonda a ~11 m: toques vizinhos no mapa reaproveitam a mesma resposta em vez
    // de gerar uma chamada externa cada.
    const key = `r:${point.lat.toFixed(4)},${point.lng.toFixed(4)}`;
    const hit = cached(key);
    if (hit) return hit[0] ?? null;

    const params = new URLSearchParams({
      lat: String(point.lat),
      lon: String(point.lng),
      format: 'jsonv2',
      addressdetails: '1',
      zoom: '18', // nível de rua/edificação
    });
    const body = await this.call(`/reverse?${params.toString()}`);
    const result = body && typeof body === 'object' ? toResult(body as NominatimPlace) : null;
    remember(key, result ? [result] : []);
    return result;
  }
}
