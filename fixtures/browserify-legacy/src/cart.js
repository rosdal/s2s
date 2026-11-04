var prices = { apple: 0.5, pear: 0.75 };
var items = [];

exports.add = (name, count) => {
  items.push({ name: name, count: count });
};

exports.total = () => items.reduce((sum, item) => sum + prices[item.name] * item.count, 0);
