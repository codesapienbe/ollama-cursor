package com.codesapienbe.olliberty

import com.codesapienbe.olliberty.settings.OllamaSettingsState
import com.codesapienbe.olliberty.util.JsonLite
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

/** Stateless HTTP client that talks to the local Ollama daemon's REST API. */
class OllamaClient(private val settings: OllamaSettingsState = OllamaSettingsState.getInstance()) {

    private val baseUrl: String get() = settings.url
    private val currentEffort: String get() = settings.effort

    private fun applyEffortToPrompt(prompt: String): String {
        val instruction = when (currentEffort) {
            "minimal" -> "Keep reasoning minimal and provide a direct answer."
            "low" -> "Use light reasoning and keep the response concise."
            "high" -> "Use deeper reasoning, including key tradeoffs and edge cases."
            "max" -> "Use very thorough reasoning before giving the final answer."
            else -> "Use balanced reasoning with concise explanations."
        }
        return "[Reasoning effort: $currentEffort] $instruction\n\n$prompt"
    }

    /** Blocking, non-streaming completion call; run off the EDT. */
    fun generate(prompt: String): String {
        val promptWithEffort = applyEffortToPrompt(prompt)
        val systemField = if (settings.systemPrompt.isNotBlank()) ""","system":${JsonLite.escape(settings.systemPrompt)}""" else ""
        val payload = """
            {"model":${JsonLite.escape(settings.model)},"prompt":${JsonLite.escape(promptWithEffort)}$systemField,"stream":false,"temperature":${settings.temperature},"options":{"num_predict":${settings.maxTokens},"num_ctx":${settings.contextLength}}}
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

    fun listModels(): List<String> {
        val connection = (URI.create("$baseUrl/api/tags").toURL().openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = 10_000
            readTimeout = 10_000
        }

        try {
            if (connection.responseCode != HttpURLConnection.HTTP_OK) {
                val errorBody = connection.errorStream?.bufferedReader()?.readText().orEmpty()
                throw OllamaException("Ollama: HTTP ${connection.responseCode} ${connection.responseMessage} $errorBody")
            }

            val body = connection.inputStream.bufferedReader().readText()
            val regex = "\"name\"\\s*:\\s*\"([^\"]+)\"".toRegex()
            return regex.findAll(body).map { it.groupValues[1] }.distinct().toList()
        } catch (e: OllamaException) {
            throw e
        } catch (e: Exception) {
            throw OllamaException("Failed to read models from Ollama: ${e.message}", e)
        } finally {
            connection.disconnect()
        }
    }

    fun getCurrentModel(): String = settings.model

    fun setModel(model: String) {
        settings.model = model.trim().ifEmpty { settings.model }
    }

    fun getEffort(): String = settings.effort

    fun setEffort(effort: String) {
        settings.effort = effort
    }
}

class OllamaException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
