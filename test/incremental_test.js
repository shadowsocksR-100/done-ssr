var ssr = require("../lib/");
var helpers = require("./helpers");
var assert = require("assert");
var path = require("path");
var Writable = require("stream").Writable;
var through = require("through2");
var createXHR = require("../lib/polyfills/xhr");
var noop = Function.prototype;

function emptyWritable() {
	return new Writable({write(c,e,next){next();}});
}

describe("Incremental rendering", function(){
	this.timeout(10000);

	before(function(){
		this.oldXHR = global.XMLHttpRequest;
		var MockXHR = helpers.mockXHR(
			'[ { "a": "a" }, { "b": "b" } ]');
		global.XMLHttpRequest = createXHR(function(){
			MockXHR.apply(this, arguments);
			this.open = MockXHR.prototype.open.bind(this);
			this.send = MockXHR.prototype.send.bind(this);
		});

		this.render = ssr({
			config: "file:" + path.join(__dirname, "tests", "package.json!npm"),
			main: "async/index.stache!done-autorender"
		}, {
			strategy: "incremental"
		});
	});

	after(function(){
		global.XMLHttpRequest = this.oldXHR;
	});

	describe("A basic async app", function(){
		before(function(done){
			var result = this.result = {
				html: null,
				instructions: []
			};

			var request = {
				url: "/",
				headers: {
					"user-agent": helpers.ua.chrome
				}
			};

			var response = through(function(buffer, enc, done){
				result.html = buffer.toString();
			});
			response.writeHead = noop;

			function instructions() {
				return new Writable({
					write(chunk, enc, next) {
						var json = chunk.toString();
						var instrs = JSON.parse(json);
						result.instructions.push(instrs);
						next();
					}
				});
			}

			var pushes = 2;
			response.push = function(url){
				pushes--;
				if(pushes === 0) {
					setTimeout(done, 10);
				}
				if(/donessr_instructions/.test(url)) {
					return instructions();
				} else if(url === "foo://bar") {
					return emptyWritable();
				}
			};

			this.render(request).pipe(response);
		});

		it("Sends the correct rendering instructions", function(){
			var instr = this.result.instructions[0][0];
			assert.equal(instr.route, "0.2.7");
			
			// Easier to test
			var nodeAsJson = JSON.stringify(instr.node);
			assert.ok(/ORDER-HISTORY/.test(nodeAsJson), "adds the order-history component");
		});

		it("Includes the styles as part of the initial HTML", function(){
			var dom = helpers.dom(this.result.html);
			// The script is the first element of the dom
			var doc = dom.nextSibling;
			var style = helpers.find(doc, function(el){
				return el.nodeName === "STYLE";
			});

			assert.ok(style, "Some styles were included");
		});
	});
});
