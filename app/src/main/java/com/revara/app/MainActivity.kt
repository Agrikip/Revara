package com.revara.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Hosts the web app from assets/www and gives it a few native abilities through `RecallNative`. */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val pickFiles =
        registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
            pendingFileCallback?.onReceiveValue(uris.toTypedArray())
            pendingFileCallback = null
        }

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                databaseEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                textZoom = 100
            }
            addJavascriptInterface(NativeBridge(this@MainActivity, this), "RecallNative")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assetLoader.shouldInterceptRequest(request.url)

                // Only the bundled app may load inside the WebView.
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    request.url.host != "appassets.androidplatform.net"
            }
            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    webView: WebView,
                    filePathCallback: ValueCallback<Array<Uri>>,
                    fileChooserParams: FileChooserParams,
                ): Boolean {
                    pendingFileCallback?.onReceiveValue(null)
                    pendingFileCallback = filePathCallback
                    pickFiles.launch(arrayOf("*/*"))
                    return true
                }
            }
        }
        setContentView(webView)
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState)
        } else {
            webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            @Suppress("DEPRECATION")
            super.onBackPressed()
        }
    }

    fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /** Methods the web app calls as `RecallNative.*`. */
    class NativeBridge(private val activity: MainActivity, private val webView: WebView) {

        @JavascriptInterface
        fun setReminder(enabled: Boolean, hour: Int, minute: Int) {
            activity.runOnUiThread { Reminders.schedule(activity, enabled, hour, minute) }
        }

        @JavascriptInterface
        fun requestNotifications() {
            activity.runOnUiThread { activity.askNotificationPermission() }
        }

        /** Writes a backup to the app cache and opens the share sheet for it. */
        @JavascriptInterface
        fun saveFile(name: String, mime: String, text: String) {
            activity.runOnUiThread {
                try {
                    val safeName = Regex("[^A-Za-z0-9._-]").replace(name, "_")
                    val dir = File(activity.cacheDir, "exports")
                    dir.mkdirs()
                    val file = File(dir, safeName)
                    file.writeText(text, Charsets.UTF_8)
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = mime
                        putExtra(Intent.EXTRA_STREAM, uri)
                        putExtra(Intent.EXTRA_SUBJECT, safeName)
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    }
                    activity.startActivity(Intent.createChooser(send, "Save or share backup"))
                } catch (e: Exception) {
                    val message = "Could not save the backup: ${e.message ?: "unknown error"}"
                    webView.evaluateJavascript("alert(${JSONObject.quote(message)})", null)
                }
            }
        }

        /**
         * HTTPS POST done natively so the web app is not blocked by CORS.
         * The result comes back through `window.__recallResolve(id, ok, text)`.
         */
        @JavascriptInterface
        fun postJson(id: String, url: String, headersJson: String, body: String) {
            thread(name = "recall-post") {
                var ok = false
                var text: String
                try {
                    val target = URL(url)
                    require(target.protocol == "https") { "Only https endpoints are allowed" }
                    val connection = target.openConnection() as HttpURLConnection
                    connection.requestMethod = "POST"
                    connection.connectTimeout = 30000
                    connection.readTimeout = 120000
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    val headers = JSONObject(headersJson)
                    for (key in headers.keys()) {
                        connection.setRequestProperty(key, headers.getString(key))
                    }
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                    val code = connection.responseCode
                    val success = code in 200..299
                    val stream = if (success) connection.inputStream else connection.errorStream
                    val response = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                    if (success) {
                        ok = true
                        text = response
                    } else {
                        text = "The AI service returned HTTP $code. ${response.take(300)}"
                    }
                    connection.disconnect()
                } catch (e: Exception) {
                    text = e.message ?: "Network request failed"
                }
                val script = "window.__recallResolve(${JSONObject.quote(id)}, $ok, ${JSONObject.quote(text)})"
                activity.runOnUiThread { webView.evaluateJavascript(script, null) }
            }
        }
    }
}
