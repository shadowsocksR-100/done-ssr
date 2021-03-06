var fs = require("fs");
var makeRequest = require("../../util/make_request");
var patch = require("dom-patch");
var path = require("path");
var Readable = require("stream").Readable;
var renderApp = require("./render_app");
var SafeStream = require("../safe");
var useragent = require("useragent");
var util = require("util");

var clientScript = getClientScript();
patch.collapseTextNodes = true;

var patchTypes = ["attribute", "replace", "insert",
	"remove", "text", "prop", "style"].reduce(truthyObject, {});

// This is needed for now, need to figure out why
patch(global.document, Function.prototype);

var IncrementalRenderingStream = function(requestOrUrl, startup, context){
	Readable.call(this);
	this.request = makeRequest(requestOrUrl);
	this.startup = startup;
	this.context = context;
	this.dests = [];
	this._hasRead = false;

	startup.promise.then(function(modules){
		this.modules = modules;
	}.bind(this));
};

util.inherits(IncrementalRenderingStream, Readable);

IncrementalRenderingStream.prototype[Symbol.for("donessr.incremental")] = true;

IncrementalRenderingStream.prototype._read = function(){
	var stream = this;
	if(!this._hasRead) {
		this._hasRead = true;
		this.startup.promise.then(function(){
			stream.dests.forEach(function(response){
				response.writeHead(200);
			});

			var response = stream.dests[0];
			if(!canIncrementalRender(stream.request, response)) {
				var ss = new SafeStream(stream.request, stream.startup, stream.context);
				stream.dests.forEach(function(response){
					ss.pipe(response);
				});
			} else {
				var promise = stream.render();
				promise.then(function(html){
					stream.push(html);
					stream.push(null);
				});
			}
		});
		return;
	}
};

IncrementalRenderingStream.prototype.render = function (){
	var request = this.request;
	var response = this.dests[0];
	
	var render = renderApp(this, request, this.modules, this.context, []);
	var doc = render.document;

	// Create the instructions stream
	var instrUrl = "/_donessr_instructions/" + Date.now();

	var instrStream = response.push(instrUrl, {
		status: 200,
		method: "GET",
		request: { accept: "*/*" },
		response: { "content-type": "text/plain" }
	});

	function onChanges(changes){
		var instructions = changes.filter(function(change){
			// Is this one of the changes that we care about.
			return patchTypes[change.type];
		});

		if(instructions.length) {
			var msg = JSON.stringify(instructions) + "\n";
			instrStream.write(msg);
		}
	}

	return render.initialStylesLoaded().then(function(){
		patch(doc, onChanges);

		// When the Zone is complete, stop listening for changes.
		render.promise.then(function(){
			patch.flush();
			patch.unbind(doc, onChanges);
			instrStream.end();
		});

		return inject(doc.documentElement.outerHTML, instrUrl);
	});
};

IncrementalRenderingStream.prototype.pipe = function(dest){
	dest.setMaxListeners(1000);
	this.dests.push(dest);
	return Readable.prototype.pipe.apply(this, arguments);
};

module.exports = IncrementalRenderingStream;

/**
 * Inject the streaming shim into some html text.
 * Injects it into the top of the HTML, if possible.
 */
function inject(html, url) {
	var inlineScript = `<script data-streamurl="${url}">${clientScript}</script>`;
	return inlineScript + html;
}

function canIncrementalRender(request, response){
	var isHttp2 = typeof response.push === "function";
	if(!isHttp2) {
		return false;
	}

	var ua = request.headers && request.headers["user-agent"];
	if(ua) {
		var res = useragent.is(ua);
		return res.chrome || res.safari;
	}
	return false;
}

function getClientScript() {
	var dir = path.dirname(require.resolve("done-ssr-incremental-rendering-client"));
	var basename = "done-ssr-incremental-rendering-client";
	var debugMode = typeof process.env.DONE_SSR_DEBUG !== "undefined";
	var clientPth = `${dir}/${basename}${debugMode ? "" : ".min"}.js`;
	return fs.readFileSync(clientPth, "utf8");
}

function truthyObject(acc, key){
	acc[key] = true;
	return acc;
}
