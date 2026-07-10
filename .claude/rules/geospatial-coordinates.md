---
paths:
  - "apps/api/src/modules/positions/**"
  - "apps/api/src/models/**"
  - "apps/dashboard/src/components/**"
  - "packages/shared/src/schemas.ts"
---

# Coordenadas Geoespaciais e Mapas

Este documento define as regras cruciais para manipulação de coordenadas geográficas, consultas de proximidade (geofencing) e renderização gráfica no mapa do Cerberus.

## Convenções de Formato de Coordenadas

| Contexto | Formato / Tipo | Ordem dos Eixos | Exemplo |
|---|---|---|---|
| **Payload de Ingestão (MQTT / Mobile)** | Objeto JSON clássico | `{ lat, lng }` | `{ "lat": -19.922, "lng": -43.945 }` |
| **Banco de Dados (MongoDB / Mongoose)** | GeoJSON Point | `[longitude, latitude]` | `coordinates: [-43.945, -19.922]` |
| **Biblioteca de Mapas (MapLibre GL)** | Array ou LngLat Object | `[longitude, latitude]` | `[-43.945, -19.922]` ou `{ lng: -43.945, lat: -19.922 }` |

## Regras Obrigatórias

1. **Inversão de Eixos (Ingestão vs Persistência)**:
   O dispositivo móvel relata telemetria no formato `{ lat, lng }` (convenção de GPS móvel). A ponte da API **deve** transpor esses valores para o formato GeoJSON `[longitude, latitude]` (eixo `X` antes do `Y`) ao gravar no MongoDB, permitindo o funcionamento dos índices espaciais.

2. **Índice Espacial `2dsphere`**:
   Toda coleção contendo dados geográficos (ex: `positions`) deve declarar o índice `2dsphere` no campo correspondente (ex: `positionSchema.index({ location: '2dsphere' })`). A sincronização dos índices ocorre no startup da API pelo Fastify plugin.

3. **Consultas de Proximidade (Geofencing)**:
   Consultas de proximidade devem usar o operador geográfico do MongoDB `$near` estruturado como GeoJSON Point:
   ```ts
   Position.find({
     location: {
       $near: {
         $geometry: { type: 'Point', coordinates: [lng, lat] },
         $maxDistance: meters
       }
     }
   })
   ```
   **Nota**: Sempre validar limites das coordenadas (`lng` entre -180 e 180, `lat` entre -90 e 90) com Zod antes de executar pesquisas geográficas para evitar crashes na engine do MongoDB.

4. **Precisão Gráfica (MapLibre)**:
   Os marcadores geográficos devem suportar atualizações fluidas de rotação baseadas no ângulo (`heading`) retornado pelo GPS do agente móvel. Se `heading` for nulo, omitir a seta direcional ou usar marcador esférico neutro.

## Por que esta regra existe

A troca inadvertida da ordem de latitude/longitude é a causa número um de marcadores plotados no oceano ou falhas catastróficas em cálculos de distância. Seguir rigidamente a transposição entre `{ lat, lng }` no cliente e `[lng, lat]` no banco e no mapa previne estes incidentes de missão crítica.
