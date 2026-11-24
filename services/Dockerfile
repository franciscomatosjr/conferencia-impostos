# Imagens das calculadoras oficiais da Receita Federal (Reforma Tributária do Consumo).
# (O mvnw dos repositórios depende de um JAR não versionado; usamos a imagem oficial do Maven.)
# O código é baixado do GitHub oficial (licença MIT) em commits fixos, sem alterações.
#   - target "regime-regular"   -> api-regime-geral   (porta 8080)
#   - target "simples-nacional" -> api-simples-nacional (porta 8082)

ARG RG_REPO=https://github.com/ReceitaFederal/calculadora-rtc-regime-regular.git
ARG RG_REF=f1eebd7ce3157423b1a6aaca7dc1d6c3395452c4
ARG SN_REPO=https://github.com/ReceitaFederal/calculadora-rtc-simples-nacional.git
ARG SN_REF=a926d5a76095ac0295a6612a9a54db7ffead2396

# ---------- código-fonte ----------
FROM alpine/git:latest AS src
ARG RG_REPO
ARG RG_REF
ARG SN_REPO
ARG SN_REF
WORKDIR /src
RUN git init -q rg && cd rg && git fetch -q --depth 1 "$RG_REPO" "$RG_REF" && git checkout -q FETCH_HEAD
RUN git init -q sn && cd sn && git fetch -q --depth 1 "$SN_REPO" "$SN_REF" && git checkout -q FETCH_HEAD

# ---------- regime regular: banco SQLite + JAR ----------
FROM maven:3.9-eclipse-temurin-25 AS rg-build
WORKDIR /build
COPY --from=src /src/rg/ ./
RUN --mount=type=cache,target=/root/.m2 \
    mkdir -p calculadora/db && \
    mvn -q flyway:migrate -Dflyway.configFiles=./flyway/flyway-pro.conf --batch-mode --errors && \
    mvn -q -DskipTests clean package --batch-mode && \
    cp target/api-regime-geral.jar /build/app.jar

# ---------- simples nacional: JAR (reaproveita o banco do regime regular) ----------
FROM maven:3.9-eclipse-temurin-25 AS sn-build
WORKDIR /build
COPY --from=src /src/sn/ ./
RUN --mount=type=cache,target=/root/.m2 \
    mvn -q -DskipTests clean package --batch-mode && \
    cp target/api-simples-nacional.jar /build/app.jar

# ---------- runtime ----------
FROM eclipse-temurin:25-jre AS regime-regular
RUN useradd -r -u 10001 app
WORKDIR /app
COPY --from=rg-build /build/app.jar app.jar
COPY --from=rg-build /build/calculadora/db/ calculadora/db/
USER app
EXPOSE 8080
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
ENTRYPOINT ["java", "-Dspring.profiles.active=offline", "-jar", "app.jar"]

FROM eclipse-temurin:25-jre AS simples-nacional
RUN useradd -r -u 10001 app
WORKDIR /app
COPY --from=sn-build /build/app.jar app.jar
COPY --from=rg-build /build/calculadora/db/ calculadora/db/
USER app
EXPOSE 8082
ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75"
ENTRYPOINT ["java", "-Dspring.profiles.active=offline", "-jar", "app.jar"]
