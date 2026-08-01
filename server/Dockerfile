# ── 构建阶段：JDK 21 + Gradle 编译 Kotlin 工程 ──
FROM gradle:8.10-jdk21 AS build
WORKDIR /app
COPY build.gradle.kts settings.gradle.kts gradlew ./
COPY gradle ./gradle
COPY src ./src
RUN gradle bootJar --no-daemon

# ── 运行阶段：JRE 21 ──
FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/build/libs/bead-server-0.1.0.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
