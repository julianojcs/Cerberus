import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearGeocodeCache, NominatimGeocodingProvider, parseHouseNumber } from './geocoding.js';

/**
 * Contrato do Nominatim fixado por resposta REAL capturada do serviço público
 * (busca "Rua da Bahia 1200", enviesada para Belo Horizonte, 19/07/2026), reduzida aos
 * campos que o adaptador consome.
 *
 * Os dois primeiros itens são o achado que motivou a deduplicação: uma rua longa vira
 * VÁRIOS resultados no OSM, um por trecho do traçado, com o mesmo endereço e
 * coordenadas a poucas centenas de metros. Sem tratar, a lista mostra a mesma rua três
 * vezes e o agente não tem como escolher.
 */
const NOMINATIM_SEARCH = [
  {
    lat: '-19.9307295',
    lon: '-43.9390996',
    addresstype: 'road',
    type: 'tertiary',
    display_name: 'Rua da Bahia, Lourdes, Regional Centro-Sul, Belo Horizonte, Minas Gerais, Brasil',
    address: {
      road: 'Rua da Bahia',
      neighbourhood: 'Lourdes',
      suburb: 'Lourdes',
      city_district: 'Regional Centro-Sul',
      city: 'Belo Horizonte',
      state: 'Minas Gerais',
      country: 'Brasil',
    },
  },
  {
    lat: '-19.9332608',
    lon: '-43.9397807',
    addresstype: 'road',
    type: 'tertiary',
    display_name: 'Rua da Bahia, Lourdes, Regional Centro-Sul, Belo Horizonte, Minas Gerais, Brasil',
    address: {
      road: 'Rua da Bahia',
      neighbourhood: 'Lourdes',
      suburb: 'Lourdes',
      city_district: 'Regional Centro-Sul',
      city: 'Belo Horizonte',
      state: 'Minas Gerais',
      country: 'Brasil',
    },
  },
  {
    lat: '-19.9245',
    lon: '-43.9352',
    addresstype: 'building',
    type: 'house',
    display_name: 'Rua da Bahia, 1200, Centro, Belo Horizonte, Minas Gerais, Brasil',
    address: {
      house_number: '1200',
      road: 'Rua da Bahia',
      suburb: 'Centro',
      city: 'Belo Horizonte',
      country: 'Brasil',
    },
  },
];

function provider() {
  return new NominatimGeocodingProvider('http://stub', 'Cerberus/teste', 'br', 1000);
}

/** URLSearchParams codifica espaço como `+`; normaliza para a asserção ficar legível. */
function readableUrl(url: unknown): string {
  return decodeURIComponent(String(url)).replace(/\+/g, ' ');
}

function okJson(body: unknown) {
  return { ok: true, json: async () => body };
}

beforeEach(() => {
  // O cache é do PROCESSO (assim como o teto de 1 req/s), então sem isto um teste
  // enxergaria a entrada que o anterior gravou e a contagem de chamadas mentiria.
  clearGeocodeCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('separação do número de porta', () => {
  it('separa o número no fim, com ou sem vírgula', () => {
    expect(parseHouseNumber('Rua da Bahia 1601')).toEqual({
      street: 'Rua da Bahia',
      houseNumber: '1601',
    });
    expect(parseHouseNumber('Rua da Bahia, 1601')).toEqual({
      street: 'Rua da Bahia',
      houseNumber: '1601',
    });
    // Sufixo de letra vai inteiro: é assim que o número está no mapa.
    expect(parseHouseNumber('Avenida Afonso Pena 1212-A')).toMatchObject({
      street: 'Avenida Afonso Pena',
      houseNumber: '1212-A',
    });
  });

  it('não confunde número que É o nome da via', () => {
    // "Rua 7" — sem nome suficiente antes do número, é o nome da via, não porta.
    expect(parseHouseNumber('Rua 7')).toEqual({ street: 'Rua 7' });
    expect(parseHouseNumber('Quadra 12')).toEqual({ street: 'Quadra 12' });
    // Número no MEIO do nome não casa com o padrão, que ancora no fim.
    expect(parseHouseNumber('Rua 15 de Novembro')).toEqual({ street: 'Rua 15 de Novembro' });
  });

  it('consulta sem número passa intacta', () => {
    expect(parseHouseNumber('Praça da Liberdade')).toEqual({ street: 'Praça da Liberdade' });
  });
});

describe('busca de endereço', () => {
  it('divide o endereço em duas linhas e dedupe trechos da mesma via', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson(NOMINATIM_SEARCH)));

    const { results } = await provider().search('Rua da Bahia 1200', { lat: -19.93, lng: -43.93 });

    // Três resultados do provedor, dois idênticos → sobram dois.
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Rua da Bahia',
      subtitle: 'Lourdes · Belo Horizonte',
      label: 'Rua da Bahia · Lourdes · Belo Horizonte',
    });
    // Com número de porta, o número entra na linha principal.
    expect(results[1]).toMatchObject({
      title: 'Rua da Bahia, 1200',
      subtitle: 'Centro · Belo Horizonte',
      kind: 'building',
    });
  });

  it('envia o viés de proximidade e o filtro de país', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson([]));
    vi.stubGlobal('fetch', fetchMock);

    await provider().search('padaria', { lat: -19.93, lng: -43.93 });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('countrycodes=br');
    expect(url).toContain('viewbox=');
    // `bounded=0`: prefere a área sem esconder um destino logo além da caixa.
    expect(url).toContain('bounded=0');
  });

  it('identifica a aplicação no User-Agent (exigência da política do Nominatim)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson([]));
    vi.stubGlobal('fetch', fetchMock);

    await provider().search('qualquer coisa');

    const init = fetchMock.mock.calls[0]![1] as { headers: Record<string, string> };
    expect(init.headers['User-Agent']).toBe('Cerberus/teste');
    expect(init.headers['Accept-Language']).toBe('pt-BR');
  });

  it('provedor fora devolve lista vazia, não exceção', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(provider().search('Rua X')).resolves.toMatchObject({ results: [] });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(provider().search('Rua Y')).resolves.toMatchObject({ results: [] });
  });

  /**
   * Caso reportado em campo (19/07/2026): buscar "Rua da Bahia 1601" devolvia três
   * trechos de "Rua da Bahia" sem número nenhum, e nada na tela dizia que o 1601 tinha
   * sido descartado. O 1601 não está mapeado no OSM — não dá para inventá-lo —, mas o
   * silêncio é o que fazia parecer que o sistema ignorou o que o usuário digitou.
   */
  describe('número de porta ausente no mapa', () => {
    const ONLY_STREETS = [
      {
        lat: '-19.9307',
        lon: '-43.9391',
        addresstype: 'road',
        address: { road: 'Rua da Bahia', suburb: 'Centro', city: 'Belo Horizonte' },
      },
    ];

    it('tenta a consulta ESTRUTURADA antes do texto livre', async () => {
      const fetchMock = vi.fn().mockResolvedValue(okJson(ONLY_STREETS));
      vi.stubGlobal('fetch', fetchMock);

      await provider().search('Rua da Bahia 1601', { lat: -19.93, lng: -43.93 });

      // A estruturada acerta o número exato; o texto livre devolve o mais próximo.
      expect(readableUrl(fetchMock.mock.calls[0]![0])).toContain('street=1601 Rua da Bahia');
    });

    it('avisa que o número não foi encontrado, em vez de descartá-lo em silêncio', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson(ONLY_STREETS)));

      const res = await provider().search('Rua da Bahia 1601', { lat: -19.93, lng: -43.93 });

      expect(res.houseNumber).toBe('1601');
      expect(res.houseNumberMatched).toBe(false);
      // A via ainda vem: o agente escolhe o trecho e ajusta o ponto no mapa.
      expect(res.results.length).toBeGreaterThan(0);
    });

    it('confirma o acerto quando o número existe no mapa', async () => {
      const withNumber = [
        {
          lat: '-19.9245',
          lon: '-43.9352',
          addresstype: 'building',
          address: {
            house_number: '1200',
            road: 'Rua da Bahia',
            suburb: 'Centro',
            city: 'Belo Horizonte',
          },
        },
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson(withNumber)));

      const res = await provider().search('Rua da Bahia 1200', { lat: -19.93, lng: -43.93 });
      expect(res.houseNumberMatched).toBe(true);
      expect(res.results[0]!.title).toBe('Rua da Bahia, 1200');
    });

    it('cai no texto livre quando a estruturada não acha nada', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(okJson([])) // estruturada vazia
        .mockResolvedValueOnce(okJson(ONLY_STREETS)); // texto livre acha a via
      vi.stubGlobal('fetch', fetchMock);

      const res = await provider().search('Rua da Bahia 1601', { lat: -19.93, lng: -43.93 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readableUrl(fetchMock.mock.calls[1]![0])).toContain('q=Rua da Bahia 1601');
      expect(res.results.length).toBeGreaterThan(0);
    });
  });

  it('reaproveita o cache em vez de repetir a chamada externa', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(NOMINATIM_SEARCH));
    vi.stubGlobal('fetch', fetchMock);

    const p = provider();
    await p.search('Praça Sete', { lat: -19.91, lng: -43.94 });
    await p.search('praça sete', { lat: -19.91, lng: -43.94 }); // caixa diferente

    // A política do Nominatim pede cache; a busca repetida não pode gerar tráfego novo.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('geocodificação reversa', () => {
  const PLACE = {
    lat: '-19.9481',
    lon: '-43.9377',
    addresstype: 'road',
    display_name: 'Rua Coral, Santa Cruz, Belo Horizonte, Minas Gerais, Brasil',
    address: { road: 'Rua Coral', suburb: 'Santa Cruz', city: 'Belo Horizonte' },
  };

  it('converte a coordenada em endereço legível', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson(PLACE)));
    const result = await provider().reverse({ lat: -19.9481, lng: -43.9377 });
    expect(result?.label).toBe('Rua Coral · Santa Cruz · Belo Horizonte');
  });

  it('sem endereço devolve null (não é erro: mar, mata, área sem mapeamento)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ error: 'Unable to geocode' })));
    await expect(provider().reverse({ lat: 0, lng: 0 })).resolves.toBeNull();
  });

  it('toques vizinhos reaproveitam a mesma resposta', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okJson(PLACE));
    vi.stubGlobal('fetch', fetchMock);

    const p = provider();
    await p.reverse({ lat: -19.94812, lng: -43.93771 });
    await p.reverse({ lat: -19.94813, lng: -43.93772 }); // ~1 m ao lado

    // Sem isto, cada toque no mapa viraria uma chamada externa.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
