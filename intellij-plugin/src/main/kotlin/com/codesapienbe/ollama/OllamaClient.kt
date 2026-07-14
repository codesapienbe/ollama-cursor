package com.codesapienbe.ollama

import com.codesapienbe.ollama.settings.OllamaSettingsState
import java.net.HttpURLConnection
import java.net.URI
import java.nio.charset.StandardCharsets

/**
 * Stateless HTTP client that talks to the local Ollama daemon's REST API.
 * Hand-rolls JSON encode/decode for the one field we care about, rather than
 * pulling in a JSON library, to avoid classloader conflicts with whatever
 * the host IDE bundles.
 */
class OllamaClient(private val settings: OllamaSettingsState = OllamaSettingsState.getInstance()) {

    private val baseUrl = "http://localhost:11434"

    /** Blocking, non-streaming completion call; run off the EDT. */
    fun generate(prompt: String): String {
        val payload = """
            {"model":${jsonString(settings.model)},"prompt":${jsonString(prompt)},"stream":false,"temperature":${settings.temperature},"options":{"num_predict":${settings.maxTokens},"num_ctx":${settings.contextLength}}}
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
            return extractResponseField(body) ?: body
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

    private fun jsonString(value: String): String {
        val sb = StringBuilder(value.length + 2)
        sb.append('"')
        for (c in value) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c.code < 0x20) sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        sb.append('"')
        return sb.toString()
    }

    /** Extracts the top-level string value of the "response" field from an Ollama JSON reply. */
    private fun extractResponseField(json: String): String? {
        val key = "\"response\":\""
        val start = json.indexOf(key)
        if (start == -1) return null
        val valueStart = start + key.length
        val sb = StringBuilder()
        var i = valueStart
        while (i < json.length) {
            val c = json[i]
            if (c == '"') break
            if (c == '\\' && i + 1 < json.length) {
                i++
                when (json[i]) {
                    '"' -> sb.append('"')
                    '\\' -> sb.append('\\')
                    '/' -> sb.append('/')
                    'n' -> sb.append('\n')
                    'r' -> sb.append('\r')
                    't' -> sb.append('\t')
                    'b' -> sb.append('\b')
                    'u' -> {
                        val hex = json.substring(i + 1, i + 5)
                        sb.append(hex.toInt(16).toChar())
                        i += 4
                    }
                    else -> sb.append(json[i])
                }
            } else {
                sb.append(c)
            }
            i++
        }
        return sb.toString()
    }
}

class OllamaException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)
