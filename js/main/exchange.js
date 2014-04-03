var util = require("./util");
var tmpl = require("./templates");
var app  = require("./app").app;
var account = require("./account");
var chart = require("./chart");

// Namespace for exchange variables
app.exchange = {
    markets:        [], // [<market>, <market>, ...]
    marketsByName:  {}, // {"LTC/BTC":<market>, ...}
};

app.addListener("DID_APP_INIT", function() {
    addMarketInfo({coin:"DOGE", basisCoin:"BTC", last:0.0000040000}); // HACK
    addMarketInfo({coin:"LTC", basisCoin:"BTC", last:0.026});         // HACK
    //updateMarkets();
});

function addMarketInfo(marketInfo) {
    var name = marketInfo.coin+"/"+marketInfo.basisCoin;
    var market = app.exchange.marketsByName[name];
    if (market) {
        market.last = Number(marketInfo.last);
    } else {
        market = Market({
            basisCoin:  marketInfo.basisCoin,
            coin:       marketInfo.coin,
            last:       Number(marketInfo.last),
        });
        app.exchange.marketsByName[name] = market;
    }
    app.exchange.markets.push(market);
}

function updateMarkets() {
    app.api("/exchange/markets",
        {},
        function(err, res) {
            if (err) {
                app.alert("Error updating markets: "+err.message);
                return;
            }
            var markets = res.data;
            app.exchange.markets = []; // reset.
            markets.forEach(function(marketInfo) {
                addMarketInfo(marketInfo);
            });

            app.emit("DID_UPDATE_MARKETS", app.exchange.markets, app.exchange.marketsByName);
        }
    );
}

////////////// MARKET
////////////// MARKET

function Market(data) {
    var market = util.newObject(Market);
    market.coin =       data.coin;
    market.basisCoin =  data.basisCoin;
    market.name =       data.coin+"/"+data.basisCoin;
    market.last =       data.last;
    market.asks = [];
    market.bids = [];
    market.pendingOrders = [];
    market.pricelogs = [];
    market.canceledOrders = {};
    return market;
}

Market.cancelOrder = function(orderId, cb) {
    var market = this;
    market.canceledOrders[orderId] = true;
    app.api("/exchange/cancel_order",
        {'id':orderId},
        cb
    );
}

Market.submitOrder = function(options, cb) {
    var market = this;
    var orderType =     options.orderType;
    var amount =        options.amount;
    var price =        +options.price;
    var coin =          market.coin;
    var basisCoin =     market.basisCoin;
    // Validate
    if (orderType != "A" && orderType != "B") { alert("Order type must be 'A' for ask or 'B' for bid"); return cb(); }
    if (amount == 0)    { alert("Please enter a valid amount of "+coin+" to buy"); return cb(); }
    if (price == 0)     { alert("Please enter a valid price"); return cb(); }
    // Convert float -> int
    amount = util.exactMultiply(amount, 8);
    // Call
    app.api("/exchange/add_order",
        {'market':market.name, 'amount':amount, 'price':price, 'order_type':orderType},
        cb
    );
}

Market.updateOrderBook = function(cb) {
    var market = this;
    app.api("/exchange/orderbook",
        {'market':this.name},
        function(err, res) {
            if (err) { cb(err); return; }
            var bids = res.data.bids;
            var asks = res.data.asks;
            var cAmount = 0.0;
            var cBAmount = 0.0;
            for (var i=0; i<bids.length; i++) {
                cAmount += bids[i].a;
                cBAmount += bids[i].a * Number(bids[i].p);
                bids[i].cba     = cBAmount.toPrecision(5);
                bids[i].ca      = cAmount.toPrecision(5);
                bids[i].a       = bids[i].a.toPrecision(5);
                bids[i].fcba    = bids[i].cba / 100000000.0;
                bids[i].fca     = bids[i].ca  / 100000000.0;
                bids[i].fa      = bids[i].a   / 100000000.0;
                bids[i].fp      = Number(bids[i].p);
            }
            cAmount = 0.0;
            cBAmount = 0.0;
            for (var i=0; i<asks.length; i++) {
                cAmount += asks[i].a;
                cBAmount += asks[i].a * Number(asks[i].p);
                asks[i].cba     = cBAmount.toPrecision(5);
                asks[i].ca      = cAmount.toPrecision(5);
                asks[i].a       = asks[i].a.toPrecision(5);
                asks[i].fcba    = asks[i].cba / 100000000.0;
                asks[i].fca     = asks[i].ca  / 100000000.0;
                asks[i].fa      = asks[i].a   / 100000000.0;
                asks[i].fp      = Number(asks[i].p);
            }
            market.asks = asks;
            market.bids = bids;
            cb(null, {bids:bids, asks:asks});
        }
    );
}

Market.updatePricelog = function(cb) {
    var start = -60*60*24; // 24 hours ago
    var market = this;
    app.api("/exchange/pricelog",
        {'market':this.name, 'start':start, 'end':0},
        function(err, res, textStatus, request) {
            if (err) { cb(err); return; }
            var now = +request.getResponseHeader("X-Server-time");
            var plogs = res.data;
            market.pricelogs = plogs;
            cb(null, plogs, start, now);
        }
    );
}

Market.updatePendingOrders = function(cb) {
    var market = this;
    app.api("/exchange/pending_orders",
        {'market':this.name},
        function(err, res) {
            if (err) { cb(err); return; }
            var orders = res.data;
            orders = orders.filter(function(order) { return !(market.canceledOrders[order.id]); });
            market.pendingOrders = orders;
            cb(null, orders);
        }
    );
}

////////////// MARKET VIEW
////////////// MARKET VIEW

function MarketView(market) {
    var view = util.newObject(MarketView);
    view.market = market;
    view.chartView = chart.ChartView(market);
    view.balanceView = undefined;
    view.updateTask = undefined;
    view.render();
    view.bindEvents();
    view.updateOrders();
    if (app.user) {
        view.updatePendingOrders();
    }
    return view;
}

MarketView.render = function() {
    var view = this;
    view.el = $(tmpl.render("exchange", {
        market:     view.market,
        bids:       undefined,
        asks:       undefined,
        user:       app.user,
    }));
    view.renderMarkets(app.exchange.markets);
    view.el.find("[data-toggle='tooltip']").tooltip();
    //view.el.find(".js-marketName").text(view.market.name);
    view.el.find(".js-chart").empty().append(view.chartView.el);
    if (app.user) {
        view.balanceView = account.BalanceView();
        view.el.find(".js-account-balance").replaceWith(view.balanceView.el);
    }
}

MarketView.renderMarkets = function(markets) {
    var view = this;
    var el = $(tmpl.render("exchange_markets", {markets:markets}));
    view.el.find(".js-exchange-markets").empty().append(el);
    view.el.find(".js-marketButton[data-market-name='"+view.market.name+"']").addClass("active");
}

MarketView.bindEvents = function() {
    var view = this;
    var bform = view.el.find("form.form-buy");
    var sform = view.el.find("form.form-sell");

    // Display calculations for buying
    bform.find("input[name='amount'],input[name='price']").on('input', function() {
        var amount = +bform.find("input[name='amount']").val();
        var price =  +bform.find("input[name='price']").val();
        if (amount > 0 && price > 0) {
            var basisAmount = util.trimToDecs(amount * price, 8);
            bform.find(".send_amount").text(basisAmount);
        }
    });

    // On buy submit
    bform.submit(function(e) {
        e.preventDefault();
        bform.disableInput();
        view.market.submitOrder({
            orderType:  "B",
            amount:     +bform.find("input[name='amount']").val(),
            price:      +bform.find("input[name='price']").val(),
        }, function(err, res) {
            bform.enableInput();
            if (err) { app.alert(err.message); return; }
            view.updatePendingOrders();
        });
        return false;
    });

    // Display calcuations for selling
    sform.find("input[name='amount'],input[name='price']").on('input', function() {
        var amount = +sform.find("input[name='amount']").val();
        var price =  +sform.find("input[name='price']").val();
        if (amount > 0 && price > 0) {
            var basisAmount = util.trimToDecs(amount * price, 8);
            sform.find(".receive_amount").text(basisAmount);
        }
    });

    // On sell submit
    sform.submit(function(e) {
        e.preventDefault();
        sform.disableInput();
        view.market.submitOrder({
            orderType:  "A",
            amount:     +sform.find("input[name='amount']").val(),
            price:      +sform.find("input[name='price']").val(),
        }, function(err, res) {
            sform.enableInput();
            if (err) { app.alert(err.message); return; }
            view.updatePendingOrders();
        });
        return false;
    });
    
    // On canceling pending orders
    view.el.on("click", ".js-cancel-order", function(e) {
        e.preventDefault();
        var button = $(this);
        var orderId = button.data("order-id");
        button.disableInput();
        view.market.cancelOrder(orderId, function(err, res) {
            button.enableInput();
            if (!err) {
                view.updatePendingOrders();
                account.updateBalance();
            }
        });
    });

    // Update the markets sidebar.
    app.addListener("DID_UPDATE_MARKETS", function(markets, marketsByName) {
        view.renderMarkets(markets);
    }, view);

    // TODO replace with sockets.
    view.updateTask = setInterval(function(){
        if (app.paused) { return; }
        view.updateOrders()
    }, 10000);
}

MarketView.updateOrders = function() {
    var view = this;
    // save scroll position on bids & asks tables
    var bidsScrollTop = view.el.find(".js-bids .exchange-orders-body").scrollTop();
    var asksScrollTop = view.el.find(".js-asks .exchange-orders-body").scrollTop();
    view.market.updateOrderBook(function(err, data) {
        if (err) { return; }

        var bids = data.bids;
        var asks = data.asks;
        var bidsEl = $(tmpl.render("exchange_orders", {orders:bids, market:view.market}));
        var asksEl = $(tmpl.render("exchange_orders", {orders:asks, market:view.market}));
        
        view.el.find(".js-bids").empty().append(bidsEl);
        view.el.find(".js-bids .js-exchange-orders-body").scrollTop(bidsScrollTop);
        view.el.find(".js-asks").empty().append(asksEl);
        view.el.find(".js-asks .js-exchange-orders-body").scrollTop(asksScrollTop);

        view.chartView.drawOrderbook(bids, asks);
        view.market.updatePricelog(function(err, plogs, start, now) {
            if (err) { return; }
            view.chartView.drawPricelog(plogs, start, now);
        });
        
    });
}

MarketView.updatePendingOrders = function() {
    var view = this;
    this.market.updatePendingOrders(function(err, orders) {
        if (err) {
            app.alert("Network error while loading pending orders.");
            return;
        }
        view.el.find(".js-pending-orders").empty().append($(tmpl.render("exchange_pending_orders", {orders:orders, market:view.market})));
    });
}

MarketView.destroy = function() {
    var view = this;
    if (view.chartView)     { view.chartView.destroy(); }
    if (view.balanceView)   { view.balanceView.destroy(); }
    if (view.updateTask)    { clearInterval(view.updateTask); }
    app.removeListenersByGroup(view);
}

////////////// HANDLERS
////////////// HANDLERS

function marketHandler(path) {
    if (path.hashParts.length != 3) {
        app.router.replacePath("/#market/DOGE/BTC");
        return;
    }
    var coin = path.hashParts[1];
    var basisCoin = path.hashParts[2];
    var name = coin+"/"+basisCoin;
    var market = app.exchange.marketsByName[name];
    if (!market) {
        app.alert("Unknown market "+name);
        return;
    }
    var view = MarketView(market);
    app.setTitle("Market::"+name);
    app.setContentView(view);
    updateMarkets();
}

module.exports = {
    MarketView:     MarketView,
    Market:         Market,
    marketHandler:  marketHandler,
    updateMarkets:  updateMarkets,
};
