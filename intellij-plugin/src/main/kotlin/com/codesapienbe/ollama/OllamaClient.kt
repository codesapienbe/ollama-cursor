package com.codesapienbe.ollama

import com.codesapienbe.ollama.settings.OllamaSettingsState
import com.codesapienbe.ollama.util.JsonLite
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

/** Stateless HTTP client that talks to the local Ollama daemon's REST API. */
class OllamaClient(private val settings: OllamaSettingsState = OllamaSettingsState.getInstance()) {

    private val baseUrl = "http://localhost:11434"

    /** Blocking, non-streaming completion call; run off the EDT. */
    fun generate(prompt: String): String {
        val payload = """
            {"model":${JsonLite.escape(settings.model)},"prompt":${JsonLite.escape(prompt)},"stream":false,"temperature":${settings.temperature},"options":{"num_predict":${settings.maxTokens},"num_ctx":${settings.contextLength}}}
        """.trimIndent()

        val connection = (URI.create("$baseUrl/api/generate").toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            doOutput = true
            connectTimeout = settings.timeoutMs.toInt()
            readTimeout = settings.timeoutMs.toInt()
            setRequestProperty("Content-Type", "application/json")
        }

        try {
            connection.outputStream.use { it.write(payload.toByteArray(StandardCharsets.UTF_8)) }

            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                val errorBody = connection.errorStream?.bufferedReader()?.readText().orEmpty()
                throw OllamaException("Ollama: HTTP ${connection.responseCode} ${connection.responseMessage} $errorBody")
            }

            val body = connection.inputStream.bufferedReader().readText()
            return JsonLite.extractStringField(body, "response") ?: body
        } catch (e: OllamaException) {
            throw e
        } catch (e: Exception) {
            throw OllamaException("Failed to connect to Ollama: ${e.message}", e)
        } finally {
            connection.disconnect()
        }
    }

    /** Cheap reachability check used to decide whether to show installer help. */
    fun isHealthy(): Boolean {
        return try {
            val connection = (URI.create("$baseUrl/api/tags").toURL().openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 5_000
                readTimeout = 5_000
            }
            val ok = connection.responseCode == HttpURLConnection.HTTP_OK
            connection.disconnect()
            ok
        } catch (e: Exception) {
            false
        }
    }
}

class OllamaException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
