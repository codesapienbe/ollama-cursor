package com.codesapienbe.olliberty.util

/**
 * Minimal hand-rolled JSON string encode/decode helpers, used instead of pulling in a JSON
 * library to avoid classloader conflicts with whatever the host IDE bundles.
 */
object JsonLite {

    /** Encodes [value] as a double-quoted, escaped JSON string literal. */
    fun escape(value: String): String {
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

    /** Extracts the top-level string value of [key] (as `"key":"value"`) from a JSON object string. */
    fun extractStringField(json: String, key: String): String? {
        val marker = "\"$key\":\""
        val start = json.indexOf(marker)
        if (start == -1) return null
        val valueStart = start + marker.length
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
